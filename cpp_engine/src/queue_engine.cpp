#include "queue_engine.hpp"

#include <algorithm>
#include <cstdio>

namespace admitflow {

QueueEngine::QueueEngine(int fairness) : fairness_(fairness < 1 ? 1 : fairness) {}

void QueueEngine::reset(int fairness) {
  fairness_ = fairness < 1 ? 1 : fairness;
  streak_ = lastSeq_ = priorityWaiting_ = regularWaiting_ = 0;
  tokens_.clear();
  appIndex_.clear();
  counters_.clear();
  counterIds_.clear();
  priorityLane_.clear();
  regularLane_.clear();
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------
std::string QueueEngine::makeCode(int level, int seq) {
  char buf[24];
  std::snprintf(buf, sizeof buf, "%c%03d", level >= 3 ? 'R' : 'P', seq);
  return buf;
}

const char* QueueEngine::statusName(Status s) {
  switch (s) {
    case Status::Waiting: return "waiting";
    case Status::Called: return "called";
    default: return "serving";
  }
}

const char* QueueEngine::laneName(Lane l) { return l == Lane::Priority ? "priority" : "regular"; }

Result QueueEngine::fail(const char* error, const std::string& message) {
  Result r;
  r.ok = false;
  r.error = error;
  r.message = message;
  return r;
}

Result QueueEngine::okWith(const TokenView& v) {
  Result r;
  r.hasToken = true;
  r.token = v;
  return r;
}

// A heap entry is live only while its token is still waiting with the same arrival number.
// Anything else is a leftover of a cancelled token (lazy deletion) and is skipped.
bool QueueEngine::isLiveEntry(const HeapEntry& e) const {
  const Token* t = tokens_.find(e.code);
  return t != nullptr && t->status == Status::Waiting && t->seq == e.seq;
}

void QueueEngine::addToLane(const Token& t) {
  if (t.lane == Lane::Priority) {
    priorityLane_.push(HeapEntry{t.level, t.seq, t.code});
    ++priorityWaiting_;
  } else {
    // Normal arrivals land at the back. A token coming back (counter closed) is slotted in by arrival
    // number so it keeps its original place in line.
    regularLane_.insertSorted(RegularEntry{t.seq, t.code},
                              [](const RegularEntry& a, const RegularEntry& b) { return a.seq < b.seq; });
    ++regularWaiting_;
  }
}

void QueueEngine::leaveWaiting(const Token& t) {
  if (t.lane == Lane::Priority) {
    --priorityWaiting_;            // its heap entry becomes stale and is skipped later
  } else {
    --regularWaiting_;
    const std::string code = t.code;
    regularLane_.removeIf([&](const RegularEntry& e) { return e.code == code; });
  }
}

// The projected order in which waiting students will be called, using exactly the same rule as callNext.
std::vector<std::string> QueueEngine::callOrder() const {
  std::vector<std::string> pri;
  PriorityHeap copy = priorityLane_;           // drain a COPY so the real heap is untouched
  HeapEntry e;
  while (copy.pop(e)) if (isLiveEntry(e)) pri.push_back(e.code);

  std::vector<std::string> reg;
  regularLane_.forEach([&](const RegularEntry& r) { reg.push_back(r.code); });

  std::vector<std::string> out;
  std::size_t p = 0, r = 0;
  int streak = streak_;
  while (p < pri.size() || r < reg.size()) {
    bool takeRegular = (p >= pri.size()) || (r < reg.size() && streak >= fairness_);
    if (takeRegular) { out.push_back(reg[r++]); streak = 0; }
    else { out.push_back(pri[p++]); ++streak; }
  }
  return out;
}

TokenView QueueEngine::view(const Token& t, const std::vector<std::string>* order) const {
  TokenView v;
  v.token = t;
  if (t.status == Status::Waiting && order != nullptr) {
    for (std::size_t i = 0; i < order->size(); ++i) {
      if ((*order)[i] == t.code) { v.position = static_cast<int>(i) + 1; v.ahead = static_cast<int>(i); break; }
    }
  }
  return v;
}

TokenView QueueEngine::finished(const Token& t, const char* finalStatus) const {
  TokenView v;
  v.token = t;
  v.finalStatus = finalStatus;
  return v;
}

// Takes the next token to call (see the call-order rule in the header). Returns nullptr when nobody waits.
Token* QueueEngine::popNext() {
  const bool havePriority = priorityWaiting_ > 0;
  const bool haveRegular = regularWaiting_ > 0;
  if (!havePriority && !haveRegular) return nullptr;

  const bool takeRegular = !havePriority || (haveRegular && streak_ >= fairness_);
  if (takeRegular) {
    RegularEntry e;
    regularLane_.pop(e);
    --regularWaiting_;
    streak_ = 0;
    return tokens_.find(e.code);
  }
  HeapEntry e;
  while (priorityLane_.pop(e)) {
    if (!isLiveEntry(e)) continue;
    --priorityWaiting_;
    ++streak_;
    return tokens_.find(e.code);
  }
  return nullptr;  // unreachable while priorityWaiting_ is consistent
}

void QueueEngine::finish(const std::string& code, Counter* counter) {
  if (counter != nullptr && counter->current == code) counter->current.clear();
  Token* t = tokens_.find(code);
  if (t != nullptr) appIndex_.erase(t->appId);
  tokens_.erase(code);
}

// ---------------------------------------------------------------------------------------------
// restore / counters
// ---------------------------------------------------------------------------------------------
Result QueueEngine::setCounter(int id, bool open) {
  if (id < 1) return fail("BAD_ARGUMENT", "Counter id must be 1 or more.");
  Counter* c = counters_.find(id);
  if (c == nullptr) {
    Counter fresh;
    fresh.id = id;
    fresh.open = open;
    counters_.put(id, fresh);
    counterIds_.push_back(id);
    std::sort(counterIds_.begin(), counterIds_.end());
    return Result();
  }
  Result r;
  if (!open && c->open) {
    Token* t = c->current.empty() ? nullptr : tokens_.find(c->current);
    if (t != nullptr && t->status == Status::Serving) {
      return fail("COUNTER_BUSY", "The counter is serving a student. Finish that student first.");
    }
    if (t != nullptr) {  // a student was called but has not arrived: put them back in their place
      t->status = Status::Waiting;
      t->counterId = 0;
      addToLane(*t);
      c->current.clear();
      r.returned.push_back(TokenView());
      r.returned.back().token = *t;   // positions are filled below, once the lanes are consistent
    }
  }
  c->open = open;
  if (!r.returned.empty()) {
    std::vector<std::string> order = callOrder();
    for (TokenView& v : r.returned) v = view(v.token, &order);
  }
  return r;
}

Result QueueEngine::load(const Token& in) {
  if (in.seq < 1 || in.level < 1 || in.level > 3) return fail("BAD_ARGUMENT", "Bad token.");
  Token t = in;
  t.lane = t.level >= 3 ? Lane::Regular : Lane::Priority;
  t.code = makeCode(t.level, t.seq);
  if (tokens_.contains(t.code) || appIndex_.contains(t.appId)) return fail("DUPLICATE_TOKEN", "Token or application already loaded.");
  if (t.status != Status::Waiting) {
    Counter* c = counters_.find(t.counterId);
    if (c == nullptr) return fail("UNKNOWN_COUNTER", "Counter not loaded.");
    if (!c->current.empty()) return fail("COUNTER_BUSY", "Counter already has a student.");
    c->current = t.code;
  } else {
    t.counterId = 0;
  }
  tokens_.put(t.code, t);
  appIndex_.put(t.appId, t.code);
  if (t.status == Status::Waiting) addToLane(t);
  if (t.seq > lastSeq_) lastSeq_ = t.seq;
  return Result();
}

// ---------------------------------------------------------------------------------------------
// queue operations
// ---------------------------------------------------------------------------------------------
Result QueueEngine::enqueue(int level, long long studentId, const std::string& appId) {
  if (level < 1 || level > 3) return fail("BAD_ARGUMENT", "Priority level must be 1, 2 or 3.");
  if (appId.empty()) return fail("BAD_ARGUMENT", "Application ID is required.");

  // O(1) duplicate check: one active token per application.
  const std::string* existing = appIndex_.find(appId);
  if (existing != nullptr) {
    Result r = findByCode(*existing);
    r.ok = false;
    r.error = "DUPLICATE_TOKEN";
    r.message = "This student already has an active token.";
    return r;
  }

  Token t;
  t.seq = ++lastSeq_;
  t.level = level;
  t.lane = level >= 3 ? Lane::Regular : Lane::Priority;
  t.code = makeCode(level, t.seq);
  t.studentId = studentId;
  t.appId = appId;
  t.status = Status::Waiting;
  tokens_.put(t.code, t);
  appIndex_.put(appId, t.code);
  addToLane(t);

  std::vector<std::string> order = callOrder();
  return okWith(view(t, &order));
}

Result QueueEngine::callNext(int counterId) {
  Counter* c = counters_.find(counterId);
  if (c == nullptr) return fail("UNKNOWN_COUNTER", "That counter does not exist.");
  if (!c->open) return fail("COUNTER_CLOSED", "That counter is closed.");
  if (!c->current.empty()) return fail("COUNTER_BUSY", "That counter already has a student. Finish or release them first.");

  Token* t = popNext();
  if (t == nullptr) return fail("QUEUE_EMPTY", "Nobody is waiting.");
  t->status = Status::Called;
  t->counterId = counterId;
  c->current = t->code;
  return okWith(view(*t, nullptr));
}

Result QueueEngine::start(const std::string& code) {
  Token* t = tokens_.find(code);
  if (t == nullptr) return fail("NOT_FOUND", "No active token with that code.");
  if (t->status != Status::Called) return fail("BAD_STATE", "Only a called student can start service.");
  t->status = Status::Serving;
  return okWith(view(*t, nullptr));
}

Result QueueEngine::complete(const std::string& code) {
  Token* t = tokens_.find(code);
  if (t == nullptr) return fail("NOT_FOUND", "No active token with that code.");
  if (t->status != Status::Serving) return fail("BAD_STATE", "Only a student being served can be completed.");
  Token copy = *t;
  finish(code, counters_.find(copy.counterId));
  return okWith(finished(copy, "completed"));
}

Result QueueEngine::noShow(const std::string& code) {
  Token* t = tokens_.find(code);
  if (t == nullptr) return fail("NOT_FOUND", "No active token with that code.");
  if (t->status != Status::Called) return fail("BAD_STATE", "Only a called student can be marked as a no-show.");
  Token copy = *t;
  finish(code, counters_.find(copy.counterId));
  return okWith(finished(copy, "no_show"));
}

Result QueueEngine::cancel(const std::string& code) {
  Token* t = tokens_.find(code);
  if (t == nullptr) return fail("NOT_FOUND", "No active token with that code.");
  if (t->status == Status::Serving) return fail("BAD_STATE", "A student being served cannot be cancelled. Complete the service instead.");
  Token copy = *t;
  if (copy.status == Status::Waiting) leaveWaiting(copy);
  finish(code, copy.counterId > 0 ? counters_.find(copy.counterId) : nullptr);
  return okWith(finished(copy, "cancelled"));
}

// ---------------------------------------------------------------------------------------------
// lookups
// ---------------------------------------------------------------------------------------------
Result QueueEngine::findByCode(const std::string& code) const {
  const Token* t = tokens_.find(code);
  if (t == nullptr) return fail("NOT_FOUND", "No active token with that code.");
  std::vector<std::string> order = callOrder();
  return okWith(view(*t, &order));
}

Result QueueEngine::findByApplication(const std::string& appId) const {
  const std::string* code = appIndex_.find(appId);
  if (code == nullptr) return fail("NOT_FOUND", "No active token for that application.");
  return findByCode(*code);
}

Snapshot QueueEngine::snapshot() const {
  Snapshot s;
  s.fairness = fairness_;
  s.streak = streak_;
  s.lastSeq = lastSeq_;
  s.priorityWaiting = priorityWaiting_;
  s.regularWaiting = regularWaiting_;
  std::vector<std::string> order = callOrder();
  for (std::size_t i = 0; i < order.size(); ++i) {
    const Token* t = tokens_.find(order[i]);
    if (t == nullptr) continue;
    TokenView v;
    v.token = *t;
    v.position = static_cast<int>(i) + 1;
    v.ahead = static_cast<int>(i);
    s.waiting.push_back(v);
  }
  for (int id : counterIds_) {
    const Counter* c = counters_.find(id);
    CounterView cv;
    cv.id = id;
    cv.open = c->open;
    if (!c->current.empty()) {
      const Token* t = tokens_.find(c->current);
      if (t != nullptr) {
        cv.hasToken = true;
        cv.token = view(*t, nullptr);
        if (t->status == Status::Called) ++s.called; else ++s.serving;
      }
    }
    s.counters.push_back(cv);
  }
  return s;
}

}  // namespace admitflow
