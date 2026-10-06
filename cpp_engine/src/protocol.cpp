#include "protocol.hpp"

#include <cstdlib>
#include <sstream>
#include <vector>

namespace admitflow {

namespace {

std::string esc(const std::string& s) {
  std::string out;
  for (char c : s) {
    if (c == '"' || c == '\\') { out += '\\'; out += c; }
    else if (static_cast<unsigned char>(c) < 0x20) out += ' ';
    else out += c;
  }
  return out;
}

bool toInt(const std::string& s, long long& out) {
  if (s.empty()) return false;
  char* end = nullptr;
  long long v = std::strtoll(s.c_str(), &end, 10);
  if (end == s.c_str() || *end != '\0') return false;
  out = v;
  return true;
}

std::string errorJson(const std::string& error, const std::string& message) {
  return "{\"ok\":false,\"error\":\"" + esc(error) + "\",\"message\":\"" + esc(message) + "\"}";
}

bool parseStatus(const std::string& s, Status& out) {
  if (s == "waiting") out = Status::Waiting;
  else if (s == "called") out = Status::Called;
  else if (s == "serving") out = Status::Serving;
  else return false;
  return true;
}

}  // namespace

std::string tokenJson(const TokenView& v) {
  const Token& t = v.token;
  std::ostringstream o;
  o << "{\"code\":\"" << esc(t.code) << "\",\"seq\":" << t.seq << ",\"lane\":\"" << QueueEngine::laneName(t.lane)
    << "\",\"level\":" << t.level << ",\"status\":\""
    << (v.finalStatus.empty() ? QueueEngine::statusName(t.status) : v.finalStatus.c_str())
    << "\",\"counterId\":" << t.counterId << ",\"studentId\":" << t.studentId << ",\"applicationId\":\"" << esc(t.appId)
    << "\",\"position\":" << v.position << ",\"ahead\":" << v.ahead << "}";
  return o.str();
}

std::string resultJson(const QueueEngine& engine, const Result& r) {
  if (!r.ok) {
    std::string out = "{\"ok\":false,\"error\":\"" + esc(r.error) + "\",\"message\":\"" + esc(r.message) + "\"";
    if (r.hasToken) out += ",\"token\":" + tokenJson(r.token);
    return out + "}";
  }
  std::string out = "{\"ok\":true";
  if (r.hasToken) out += ",\"token\":" + tokenJson(r.token);
  out += ",\"returned\":[";
  for (std::size_t i = 0; i < r.returned.size(); ++i) {
    if (i) out += ",";
    out += tokenJson(r.returned[i]);
  }
  out += "],\"streak\":" + std::to_string(engine.streak()) + "}";
  return out;
}

std::string snapshotJson(const Snapshot& s) {
  std::ostringstream o;
  o << "{\"ok\":true,\"fairness\":" << s.fairness << ",\"streak\":" << s.streak << ",\"lastSeq\":" << s.lastSeq
    << ",\"priorityWaiting\":" << s.priorityWaiting << ",\"regularWaiting\":" << s.regularWaiting
    << ",\"called\":" << s.called << ",\"serving\":" << s.serving << ",\"counters\":[";
  for (std::size_t i = 0; i < s.counters.size(); ++i) {
    const CounterView& c = s.counters[i];
    if (i) o << ",";
    o << "{\"id\":" << c.id << ",\"open\":" << (c.open ? "true" : "false") << ",\"token\":"
      << (c.hasToken ? tokenJson(c.token) : "null") << "}";
  }
  o << "],\"waiting\":[";
  for (std::size_t i = 0; i < s.waiting.size(); ++i) {
    if (i) o << ",";
    o << tokenJson(s.waiting[i]);
  }
  o << "]}";
  return o.str();
}

std::string handleLine(QueueEngine& engine, const std::string& rawLine, bool& quit) {
  std::istringstream in(rawLine);
  std::vector<std::string> a;
  for (std::string w; in >> w;) a.push_back(w);
  if (a.empty()) return errorJson("BAD_COMMAND", "Empty command.");

  const std::string& cmd = a[0];
  long long n1 = 0, n2 = 0, n3 = 0, n4 = 0, n5 = 0;

  if (cmd == "QUIT") { quit = true; return "{\"ok\":true}"; }

  if (cmd == "RESET") {
    if (a.size() != 2 || !toInt(a[1], n1) || n1 < 1 || n1 > 1000) return errorJson("BAD_ARGUMENT", "RESET <fairness 1-1000>");
    engine.reset(static_cast<int>(n1));
    return resultJson(engine, Result());
  }
  if (cmd == "COUNTER") {
    if (a.size() != 3 || !toInt(a[1], n1) || !toInt(a[2], n2) || (n2 != 0 && n2 != 1)) return errorJson("BAD_ARGUMENT", "COUNTER <id> <0|1>");
    return resultJson(engine, engine.setCounter(static_cast<int>(n1), n2 == 1));
  }
  if (cmd == "SEQ") {
    if (a.size() != 2 || !toInt(a[1], n1) || n1 < 0) return errorJson("BAD_ARGUMENT", "SEQ <n>");
    engine.setLastSeq(static_cast<int>(n1));
    return resultJson(engine, Result());
  }
  if (cmd == "STREAK") {
    if (a.size() != 2 || !toInt(a[1], n1) || n1 < 0) return errorJson("BAD_ARGUMENT", "STREAK <n>");
    engine.setStreak(static_cast<int>(n1));
    return resultJson(engine, Result());
  }
  if (cmd == "LOAD") {
    Token t;
    if (a.size() != 7 || !toInt(a[1], n1) || !toInt(a[2], n2) || !parseStatus(a[3], t.status) || !toInt(a[4], n3) || !toInt(a[5], n4)) {
      return errorJson("BAD_ARGUMENT", "LOAD <seq> <level> <status> <counter> <studentId> <appId>");
    }
    t.seq = static_cast<int>(n1);
    t.level = static_cast<int>(n2);
    t.counterId = static_cast<int>(n3);
    t.studentId = n4;
    t.appId = a[6];
    return resultJson(engine, engine.load(t));
  }
  if (cmd == "ENQUEUE") {
    if (a.size() != 4 || !toInt(a[1], n1) || !toInt(a[2], n2)) return errorJson("BAD_ARGUMENT", "ENQUEUE <level> <studentId> <appId>");
    return resultJson(engine, engine.enqueue(static_cast<int>(n1), n2, a[3]));
  }
  if (cmd == "CALL") {
    if (a.size() != 2 || !toInt(a[1], n1)) return errorJson("BAD_ARGUMENT", "CALL <counter>");
    return resultJson(engine, engine.callNext(static_cast<int>(n1)));
  }
  if (cmd == "START" || cmd == "COMPLETE" || cmd == "NOSHOW" || cmd == "CANCEL" || cmd == "FIND_TOKEN" || cmd == "FIND_APP") {
    if (a.size() != 2) return errorJson("BAD_ARGUMENT", cmd + " <value>");
    Result r;
    if (cmd == "START") r = engine.start(a[1]);
    else if (cmd == "COMPLETE") r = engine.complete(a[1]);
    else if (cmd == "NOSHOW") r = engine.noShow(a[1]);
    else if (cmd == "CANCEL") r = engine.cancel(a[1]);
    else if (cmd == "FIND_TOKEN") r = engine.findByCode(a[1]);
    else r = engine.findByApplication(a[1]);
    return resultJson(engine, r);
  }
  (void)n5;
  if (cmd == "SNAPSHOT") return snapshotJson(engine.snapshot());
  return errorJson("BAD_COMMAND", "Unknown command: " + cmd);
}

}  // namespace admitflow
