// AdmitFlow QueueEngine Implementation
// Core queue engine for physical document verification (Phase 4).

#include <iostream>
#include <string>
#include <vector>
#include <algorithm>
#include <cstdio>

#include "queue_engine.h"

using namespace std;

namespace admitflow {

// Constructor: initialize fairness burst limit (minimum 1)
QueueEngine::QueueEngine(int fairness) : fairness_(fairness < 1 ? 1 : fairness) {}

// Resets all state, counters, active token hash maps, and waiting lanes
void QueueEngine::reset(int fairness) {
  fairness_ = (fairness < 1) ? 1 : fairness;
  streak_ = 0;
  lastSeq_ = 0;
  priorityWaiting_ = 0;
  regularWaiting_ = 0;

  tokens_.clear();
  appIndex_.clear();
  counters_.clear();
  counterIds_.clear();
  priorityLane_.clear();
  regularLane_.clear();
}

// Generates token code: 'P' for priority levels 1-2, 'R' for regular level 3
string QueueEngine::makeCode(int level, int seq) {
  char buffer[24];
  char prefix = (level >= 3) ? 'R' : 'P';
  snprintf(buffer, sizeof(buffer), "%c%03d", prefix, seq);
  return string(buffer);
}

const char* QueueEngine::statusName(Status s) {
  switch (s) {
    case Status::Waiting:
      return "waiting";
    case Status::Called:
      return "called";
    default:
      return "serving";
  }
}

const char* QueueEngine::laneName(Lane l) {
  return (l == Lane::Priority) ? "priority" : "regular";
}

Result QueueEngine::fail(const char* errorCode, const string& message) {
  Result res;
  res.ok = false;
  res.error = errorCode;
  res.message = message;
  return res;
}

Result QueueEngine::okWith(const TokenView& view) {
  Result res;
  res.ok = true;
  res.hasToken = true;
  res.token = view;
  return res;
}

// Validates whether a heap entry is still live in waiting state (lazy deletion check)
bool QueueEngine::isLiveEntry(const HeapEntry& entry) const {
  const Token* token = tokens_.find(entry.code);
  return (token != nullptr && token->status == Status::Waiting && token->seq == entry.seq);
}

// Adds token to the corresponding lane
void QueueEngine::addToLane(const Token& token) {
  if (token.lane == Lane::Priority) {
    // Priority lane uses a binary min-heap ordered by (level, seq)
    priorityLane_.push(HeapEntry{token.level, token.seq, token.code});
    priorityWaiting_++;
  } else {
    // Regular lane uses a FIFO queue, inserting sorted by sequence number
    // so returning students preserve their original spot in line!
    regularLane_.insertSorted(
        RegularEntry{token.seq, token.code},
        [](const RegularEntry& a, const RegularEntry& b) {
          return a.seq < b.seq;
        });
    regularWaiting_++;
  }
}

// Removes a token from the waiting lane
void QueueEngine::leaveWaiting(const Token& token) {
  if (token.lane == Lane::Priority) {
    priorityWaiting_--; // Heap entry skipped later lazily
  } else {
    regularWaiting_--;
    const string targetCode = token.code;
    regularLane_.removeIf([&](const RegularEntry& entry) {
      return entry.code == targetCode;
    });
  }
}

// Computes the projected call order of all waiting students
vector<string> QueueEngine::callOrder() const {
  // 1. Extract live priority students in heap order from a copy of the heap
  vector<string> priorityTokens;
  PriorityHeap heapCopy = priorityLane_;
  HeapEntry heapEntry;
  while (heapCopy.pop(heapEntry)) {
    if (isLiveEntry(heapEntry)) {
      priorityTokens.push_back(heapEntry.code);
    }
  }

  // 2. Extract regular students in FIFO order
  vector<string> regularTokens;
  regularLane_.forEach([&](const RegularEntry& regEntry) {
    regularTokens.push_back(regEntry.code);
  });

  // 3. Simulate fairness rule interleaving
  vector<string> orderResult;
  size_t pIndex = 0;
  size_t rIndex = 0;
  int currentStreak = streak_;

  while (pIndex < priorityTokens.size() || rIndex < regularTokens.size()) {
    bool noPriority = (pIndex >= priorityTokens.size());
    bool hasRegular = (rIndex < regularTokens.size());
    bool burstLimit = (currentStreak >= fairness_);

    bool pickRegular = noPriority || (hasRegular && burstLimit);

    if (pickRegular) {
      orderResult.push_back(regularTokens[rIndex++]);
      currentStreak = 0;
    } else {
      orderResult.push_back(priorityTokens[pIndex++]);
      currentStreak++;
    }
  }

  return orderResult;
}

// Populates live position and ahead counts
TokenView QueueEngine::view(const Token& token, const vector<string>* order) const {
  TokenView tokenView;
  tokenView.token = token;

  if (token.status == Status::Waiting && order != nullptr) {
    for (size_t i = 0; i < order->size(); i++) {
      if ((*order)[i] == token.code) {
        tokenView.position = static_cast<int>(i) + 1;
        tokenView.ahead = static_cast<int>(i);
        break;
      }
    }
  }

  return tokenView;
}

TokenView QueueEngine::finished(const Token& token, const char* finalStatus) const {
  TokenView tokenView;
  tokenView.token = token;
  tokenView.finalStatus = finalStatus;
  return tokenView;
}

// Selects the next token to call using the fairness rule
Token* QueueEngine::popNext() {
  bool hasPriority = (priorityWaiting_ > 0);
  bool hasRegular = (regularWaiting_ > 0);

  if (!hasPriority && !hasRegular) {
    return nullptr;
  }

  bool callRegular = !hasPriority || (hasRegular && streak_ >= fairness_);

  if (callRegular) {
    RegularEntry regEntry;
    regularLane_.pop(regEntry);
    regularWaiting_--;
    streak_ = 0;
    return tokens_.find(regEntry.code);
  }

  HeapEntry heapEntry;
  while (priorityLane_.pop(heapEntry)) {
    if (!isLiveEntry(heapEntry)) {
      continue; // Skip stale cancelled entry
    }
    priorityWaiting_--;
    streak_++;
    return tokens_.find(heapEntry.code);
  }

  return nullptr;
}

// Cleans up a token after lifecycle completion
void QueueEngine::finish(const string& code, Counter* counter) {
  if (counter != nullptr && counter->current == code) {
    counter->current.clear();
  }

  Token* token = tokens_.find(code);
  if (token != nullptr) {
    appIndex_.erase(token->appId);
  }

  tokens_.erase(code);
}

// Creates, opens, or closes a counter
Result QueueEngine::setCounter(int counterId, bool isOpen) {
  if (counterId < 1) {
    return fail("BAD_ARGUMENT", "Counter id must be 1 or more.");
  }

  Counter* counter = counters_.find(counterId);

  if (counter == nullptr) {
    Counter newCounter;
    newCounter.id = counterId;
    newCounter.open = isOpen;
    counters_.put(counterId, newCounter);

    counterIds_.push_back(counterId);
    sort(counterIds_.begin(), counterIds_.end());
    return Result();
  }

  Result result;

  if (!isOpen && counter->open) {
    Token* currentToken = counter->current.empty() ? nullptr : tokens_.find(counter->current);

    if (currentToken != nullptr && currentToken->status == Status::Serving) {
      return fail("COUNTER_BUSY", "The counter is serving a student. Finish that student first.");
    }

    if (currentToken != nullptr) {
      // Re-insert called student back into waiting lane preserving original position
      currentToken->status = Status::Waiting;
      currentToken->counterId = 0;
      addToLane(*currentToken);
      counter->current.clear();

      TokenView returnedView;
      returnedView.token = *currentToken;
      result.returned.push_back(returnedView);
    }
  }

  counter->open = isOpen;

  if (!result.returned.empty()) {
    vector<string> order = callOrder();
    for (TokenView& item : result.returned) {
      item = view(item.token, &order);
    }
  }

  return result;
}

// Restores token state on startup
Result QueueEngine::load(const Token& inputToken) {
  if (inputToken.seq < 1 || inputToken.level < 1 || inputToken.level > 3) {
    return fail("BAD_ARGUMENT", "Bad token.");
  }

  Token token = inputToken;
  token.lane = (token.level >= 3) ? Lane::Regular : Lane::Priority;
  token.code = makeCode(token.level, token.seq);

  if (tokens_.contains(token.code) || appIndex_.contains(token.appId)) {
    return fail("DUPLICATE_TOKEN", "Token or application already loaded.");
  }

  if (token.status != Status::Waiting) {
    Counter* counter = counters_.find(token.counterId);
    if (counter == nullptr) {
      return fail("UNKNOWN_COUNTER", "Counter not loaded.");
    }
    if (!counter->current.empty()) {
      return fail("COUNTER_BUSY", "Counter already has a student.");
    }
    counter->current = token.code;
  } else {
    token.counterId = 0;
  }

  tokens_.put(token.code, token);
  appIndex_.put(token.appId, token.code);

  if (token.status == Status::Waiting) {
    addToLane(token);
  }

  if (token.seq > lastSeq_) {
    lastSeq_ = token.seq;
  }

  return Result();
}

// Enqueues student and issues unique token
Result QueueEngine::enqueue(int priorityLevel, long long studentId, const string& applicationId) {
  if (priorityLevel < 1 || priorityLevel > 3) {
    return fail("BAD_ARGUMENT", "Priority level must be 1, 2 or 3.");
  }
  if (applicationId.empty()) {
    return fail("BAD_ARGUMENT", "Application ID is required.");
  }

  // O(1) duplicate token prevention
  const string* existingCode = appIndex_.find(applicationId);
  if (existingCode != nullptr) {
    Result duplicateResult = findByCode(*existingCode);
    duplicateResult.ok = false;
    duplicateResult.error = "DUPLICATE_TOKEN";
    duplicateResult.message = "This student already has an active token.";
    return duplicateResult;
  }

  Token newToken;
  newToken.seq = ++lastSeq_;
  newToken.level = priorityLevel;
  newToken.lane = (priorityLevel >= 3) ? Lane::Regular : Lane::Priority;
  newToken.code = makeCode(priorityLevel, newToken.seq);
  newToken.studentId = studentId;
  newToken.appId = applicationId;
  newToken.status = Status::Waiting;

  tokens_.put(newToken.code, newToken);
  appIndex_.put(applicationId, newToken.code);
  addToLane(newToken);

  vector<string> currentOrder = callOrder();
  return okWith(view(newToken, &currentOrder));
}

// Calls next eligible student to specified counter
Result QueueEngine::callNext(int counterId) {
  Counter* counter = counters_.find(counterId);
  if (counter == nullptr) {
    return fail("UNKNOWN_COUNTER", "That counter does not exist.");
  }
  if (!counter->open) {
    return fail("COUNTER_CLOSED", "That counter is closed.");
  }
  if (!counter->current.empty()) {
    return fail("COUNTER_BUSY", "That counter already has a student. Finish or release them first.");
  }

  Token* nextToken = popNext();
  if (nextToken == nullptr) {
    return fail("QUEUE_EMPTY", "Nobody is waiting.");
  }

  nextToken->status = Status::Called;
  nextToken->counterId = counterId;
  counter->current = nextToken->code;

  return okWith(view(*nextToken, nullptr));
}

// Starts service: Called -> Serving
Result QueueEngine::start(const string& tokenCode) {
  Token* token = tokens_.find(tokenCode);
  if (token == nullptr) {
    return fail("NOT_FOUND", "No active token with that code.");
  }
  if (token->status != Status::Called) {
    return fail("BAD_STATE", "Only a called student can start service.");
  }

  token->status = Status::Serving;
  return okWith(view(*token, nullptr));
}

// Completes service: Serving -> Done (completed)
Result QueueEngine::complete(const string& tokenCode) {
  Token* token = tokens_.find(tokenCode);
  if (token == nullptr) {
    return fail("NOT_FOUND", "No active token with that code.");
  }
  if (token->status != Status::Serving) {
    return fail("BAD_STATE", "Only a student being served can be completed.");
  }

  Token tokenCopy = *token;
  finish(tokenCode, counters_.find(tokenCopy.counterId));
  return okWith(finished(tokenCopy, "completed"));
}

// Marks student as no-show: Called -> Done (no_show)
Result QueueEngine::noShow(const string& tokenCode) {
  Token* token = tokens_.find(tokenCode);
  if (token == nullptr) {
    return fail("NOT_FOUND", "No active token with that code.");
  }
  if (token->status != Status::Called) {
    return fail("BAD_STATE", "Only a called student can be marked as a no-show.");
  }

  Token tokenCopy = *token;
  finish(tokenCode, counters_.find(tokenCopy.counterId));
  return okWith(finished(tokenCopy, "no_show"));
}

// Cancels student: Waiting/Called -> Done (cancelled)
Result QueueEngine::cancel(const string& tokenCode) {
  Token* token = tokens_.find(tokenCode);
  if (token == nullptr) {
    return fail("NOT_FOUND", "No active token with that code.");
  }
  if (token->status == Status::Serving) {
    return fail("BAD_STATE", "A student being served cannot be cancelled. Complete the service instead.");
  }

  Token tokenCopy = *token;
  if (tokenCopy.status == Status::Waiting) {
    leaveWaiting(tokenCopy);
  }

  Counter* counter = (tokenCopy.counterId > 0) ? counters_.find(tokenCopy.counterId) : nullptr;
  finish(tokenCode, counter);

  return okWith(finished(tokenCopy, "cancelled"));
}

Result QueueEngine::findByCode(const string& tokenCode) const {
  const Token* token = tokens_.find(tokenCode);
  if (token == nullptr) {
    return fail("NOT_FOUND", "No active token with that code.");
  }

  vector<string> currentOrder = callOrder();
  return okWith(view(*token, &currentOrder));
}

Result QueueEngine::findByApplication(const string& applicationId) const {
  const string* tokenCode = appIndex_.find(applicationId);
  if (tokenCode == nullptr) {
    return fail("NOT_FOUND", "No active token for that application.");
  }

  return findByCode(*tokenCode);
}

// Generates complete snapshot of engine state
Snapshot QueueEngine::snapshot() const {
  Snapshot snap;
  snap.fairness = fairness_;
  snap.streak = streak_;
  snap.lastSeq = lastSeq_;
  snap.priorityWaiting = priorityWaiting_;
  snap.regularWaiting = regularWaiting_;

  vector<string> projectedOrder = callOrder();
  for (size_t i = 0; i < projectedOrder.size(); i++) {
    const Token* token = tokens_.find(projectedOrder[i]);
    if (token == nullptr) {
      continue;
    }

    TokenView tokenView;
    tokenView.token = *token;
    tokenView.position = static_cast<int>(i) + 1;
    tokenView.ahead = static_cast<int>(i);
    snap.waiting.push_back(tokenView);
  }

  for (int counterId : counterIds_) {
    const Counter* counter = counters_.find(counterId);
    CounterView counterView;
    counterView.id = counterId;
    counterView.open = counter->open;

    if (!counter->current.empty()) {
      const Token* currentToken = tokens_.find(counter->current);
      if (currentToken != nullptr) {
        counterView.hasToken = true;
        counterView.token = view(*currentToken, nullptr);

        if (currentToken->status == Status::Called) {
          snap.called++;
        } else {
          snap.serving++;
        }
      }
    }

    snap.counters.push_back(counterView);
  }

  return snap;
}

}  // namespace admitflow
