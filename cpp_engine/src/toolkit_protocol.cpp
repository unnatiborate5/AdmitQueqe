#include "toolkit.hpp"

#include <cstdio>
#include <cstdlib>
#include <sstream>
#include <vector>

#include "planner.hpp"
#include "protocol.hpp"
#include "reports.hpp"

namespace admitflow {

namespace {

std::vector<std::string> splitOn(const std::string& s, char sep) {
  std::vector<std::string> out;
  std::string cur;
  for (char c : s) { if (c == sep) { out.push_back(cur); cur.clear(); } else cur += c; }
  out.push_back(cur);
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

std::string decodeName(std::string s) { for (char& c : s) if (c == '~') c = ' '; return s; }

std::string err(const std::string& code, const std::string& message) {
  return "{\"ok\":false,\"error\":\"" + jsonEscape(code) + "\",\"message\":\"" + jsonEscape(message) + "\"}";
}

std::string idList(const std::vector<long long>& ids) {
  std::string out = "[";
  for (std::size_t i = 0; i < ids.size(); ++i) { if (i) out += ","; out += std::to_string(ids[i]); }
  return out + "]";
}

std::string statsJson(const SearchStats& s) {
  return "\"algorithm\":\"" + s.algorithm + "\",\"comparisons\":" + std::to_string(s.comparisons) + ",\"size\":" + std::to_string(s.size);
}

std::string entryJson(const UndoEntry& e) {
  return "{\"actionId\":" + std::to_string(e.actionId) + ",\"studentId\":" + std::to_string(e.studentId) + ",\"kind\":\"" + jsonEscape(e.kind) + "\"}";
}

template <typename T, typename F>
std::string arrayJson(const std::vector<T>& v, F fmt) {
  std::string out = "[";
  for (std::size_t i = 0; i < v.size(); ++i) { if (i) out += ","; out += fmt(v[i]); }
  return out + "]";
}

const std::size_t MAX_ITEMS = 20000;

// Checks "<cmd> ... <n> item1 ... itemN": returns false with a ready error reply when malformed.
bool itemsAt(const std::vector<std::string>& a, std::size_t countAt, std::vector<std::string>& items, std::string& error) {
  long long n = 0;
  if (a.size() <= countAt || !toInt(a[countAt], n) || n < 0 || static_cast<std::size_t>(n) > MAX_ITEMS || a.size() != countAt + 1 + static_cast<std::size_t>(n)) {
    error = err("BAD_ARGUMENT", "Item count does not match the items given.");
    return false;
  }
  items.assign(a.begin() + static_cast<std::ptrdiff_t>(countAt) + 1, a.end());
  return true;
}

}  // namespace

std::string handleToolkitLine(Toolkit& tk, const std::string& line, bool& quit) {
  std::istringstream in(line);
  std::vector<std::string> a;
  for (std::string w; in >> w;) a.push_back(w);
  if (a.empty()) return handleLine(tk.queue, line, quit);
  const std::string& cmd = a[0];
  long long n1 = 0, n2 = 0, n3 = 0;
  std::string error;
  std::vector<std::string> items;

  // ------------------------------------------------------------------ searching
  if (cmd == "INDEX_CLEAR") { tk.index.clear(); return "{\"ok\":true}"; }

  if (cmd == "INDEX_ADD") {
    if (!itemsAt(a, 1, items, error)) return error;
    for (const std::string& it : items) {
      std::vector<std::string> f = splitOn(it, ':');
      if (f.size() != 3 || !toInt(f[0], n1) || f[1].empty()) return err("BAD_ARGUMENT", "INDEX_ADD item: id:APPID:name");
      tk.index.addStudent(n1, f[1], decodeName(f[2]));
    }
    return "{\"ok\":true,\"added\":" + std::to_string(items.size()) + "}";
  }
  if (cmd == "INDEX_TOKENS") {
    if (!itemsAt(a, 1, items, error)) return error;
    for (const std::string& it : items) {
      std::vector<std::string> f = splitOn(it, ':');
      if (f.size() != 3 || !toInt(f[0], n1) || f[1].size() != 1 || !toInt(f[2], n2)) return err("BAD_ARGUMENT", "INDEX_TOKENS item: number:lane:studentId");
      tk.index.addToken(static_cast<int>(n1), f[1][0], n2);
    }
    return "{\"ok\":true,\"added\":" + std::to_string(items.size()) + "}";
  }
  if (cmd == "INDEX_BUILD") {
    const std::size_t cmp = tk.index.build();
    return "{\"ok\":true,\"students\":" + std::to_string(tk.index.students()) + ",\"tokens\":" + std::to_string(tk.index.tokens()) +
           ",\"algorithm\":\"merge sort\",\"comparisons\":" + std::to_string(cmp) + "}";
  }
  if (cmd == "SEARCH_APP" || cmd == "SEARCH_TOKEN" || cmd == "SEARCH_NAME") {
    if (a.size() != 2) return err("BAD_ARGUMENT", cmd + " <value>");
    if (!tk.index.built()) return err("NOT_BUILT", "The search index has not been built.");
    SearchStats st;
    if (cmd == "SEARCH_APP") {
      std::vector<long long> ids = tk.index.findByApplicationPrefix(a[1], st);
      return "{\"ok\":true," + statsJson(st) + ",\"matches\":" + idList(ids) + "}";
    }
    if (cmd == "SEARCH_TOKEN") {
      long long id = 0;
      bool found = tk.index.findToken(a[1], id, st);
      return "{\"ok\":true," + statsJson(st) + ",\"matches\":" + idList(found ? std::vector<long long>{id} : std::vector<long long>{}) + "}";
    }
    std::vector<long long> ids = tk.index.findByName(decodeName(a[1]), st);
    return "{\"ok\":true," + statsJson(st) + ",\"matches\":" + idList(ids) + "}";
  }

  // ------------------------------------------------------------------ sorting
  if (cmd == "SORT") {
    SortMode mode;
    if (a.size() < 3 || !parseSortMode(a[1], mode)) return err("BAD_ARGUMENT", "SORT <unscheduled|arrivals_time|arrivals_priority|arrivals_token> <n> items");
    if (!itemsAt(a, 2, items, error)) return error;
    std::vector<WorkItem> work;
    for (const std::string& it : items) {
      std::vector<std::string> f = splitOn(it, ':');
      long long id, level, minutes, token, wait;
      if (f.size() != 6 || !toInt(f[0], id) || !toInt(f[1], level) || !toInt(f[2], minutes) || !toInt(f[3], token) || !toInt(f[4], wait)) {
        return err("BAD_ARGUMENT", "SORT item: id:level:minutes:token:waitKey:name");
      }
      WorkItem w;
      w.id = id; w.level = static_cast<int>(level); w.minutes = static_cast<int>(minutes); w.token = static_cast<int>(token); w.waitKey = wait;
      w.name = SearchIndex::lower(decodeName(f[5]));
      work.push_back(w);
    }
    const std::size_t cmp = sortWork(work, mode);
    std::vector<long long> ids;
    for (const WorkItem& w : work) ids.push_back(w.id);
    return "{\"ok\":true,\"algorithm\":\"merge sort\",\"comparisons\":" + std::to_string(cmp) + ",\"size\":" + std::to_string(work.size()) + ",\"order\":" + idList(ids) + "}";
  }

  // ------------------------------------------------------------------ stack (undo)
  if (cmd == "STACK_PUSH") {
    if (a.size() != 5 || !toInt(a[1], n1) || !toInt(a[2], n2) || !toInt(a[3], n3) || a[4].empty()) return err("BAD_ARGUMENT", "STACK_PUSH <admin> <actionId> <studentId> <kind>");
    UndoEntry e; e.actionId = n2; e.studentId = n3; e.kind = a[4];
    UndoEntry dropped;
    const bool did = tk.undo.push(n1, e, &dropped);
    return "{\"ok\":true,\"size\":" + std::to_string(tk.undo.size(n1)) + ",\"dropped\":" + std::to_string(did ? dropped.actionId : 0) + "}";
  }
  if (cmd == "STACK_POP" || cmd == "STACK_PEEK" || cmd == "STACK_LIST") {
    if (a.size() != 2 || !toInt(a[1], n1)) return err("BAD_ARGUMENT", cmd + " <admin>");
    if (cmd == "STACK_LIST") return "{\"ok\":true,\"size\":" + std::to_string(tk.undo.size(n1)) + ",\"entries\":" + arrayJson(tk.undo.list(n1), entryJson) + "}";
    UndoEntry e;
    if (cmd == "STACK_PEEK") {
      const UndoEntry* top = tk.undo.peek(n1);
      if (top == nullptr) return err("EMPTY", "Nothing to undo.");
      return "{\"ok\":true,\"size\":" + std::to_string(tk.undo.size(n1)) + ",\"entry\":" + entryJson(*top) + "}";
    }
    if (!tk.undo.pop(n1, e)) return err("EMPTY", "Nothing to undo.");
    return "{\"ok\":true,\"size\":" + std::to_string(tk.undo.size(n1)) + ",\"entry\":" + entryJson(e) + "}";
  }
  if (cmd == "STACK_CLEAR_ALL") { tk.undo.clearAll(); return "{\"ok\":true}"; }

  // ------------------------------------------------------------------ matrices
  if (cmd == "APPT_LOAD") {
    long long rows, cols, from, to;
    if (a.size() < 6 || !toInt(a[1], rows) || !toInt(a[2], cols) || !toInt(a[3], from) || !toInt(a[4], to) || rows > 400 || cols > 400) return err("BAD_ARGUMENT", "APPT_LOAD <rows> <cols> <fromCol> <toCol> <n> day:slot ...");
    if (!itemsAt(a, 5, items, error)) return error;
    std::vector<std::pair<int, int>> bookings;
    for (const std::string& it : items) {
      std::vector<std::string> f = splitOn(it, ':');
      if (f.size() != 2 || !toInt(f[0], n1) || !toInt(f[1], n2)) return err("BAD_ARGUMENT", "APPT_LOAD item: day:slot");
      bookings.push_back({static_cast<int>(n1), static_cast<int>(n2)});
    }
    LoadReport r;
    if (!computeAppointmentLoad(static_cast<int>(rows), static_cast<int>(cols), static_cast<int>(from), static_cast<int>(to), bookings, r)) return err("BAD_ARGUMENT", "Booking outside the grid or bad range.");
    auto cell = [](const LoadCell& c) { return "[" + std::to_string(c.row) + "," + std::to_string(c.col) + "," + std::to_string(c.count) + "]"; };
    auto num = [](int v) { return std::to_string(v); };
    std::ostringstream o;
    o << "{\"ok\":true,\"rows\":" << r.rows << ",\"cols\":" << r.cols << ",\"nonZeros\":" << r.nonZeros << ",\"density\":" << r.density
      << ",\"bookings\":" << bookings.size() << ",\"cells\":" << arrayJson(r.cells, cell) << ",\"rowSums\":" << arrayJson(r.rowSums, num)
      << ",\"colSums\":" << arrayJson(r.colSums, num) << ",\"busiest\":" << arrayJson(r.busiest, cell)
      << ",\"bestSlots\":" << arrayJson(r.bestSlots, [](const BestSlot& b) { return "[" + std::to_string(b.col) + "," + std::to_string(b.count) + "]"; })
      << ",\"lookupComparisons\":" << r.lookupComparisons << "}";
    return o.str();
  }
  if (cmd == "DOC_READINESS") {
    long long docs, rounds;
    if (a.size() < 3 || !toInt(a[1], docs) || !toInt(a[2], rounds) || docs < 1 || rounds < 1 || docs > 100 || rounds > 100) return err("BAD_ARGUMENT", "DOC_READINESS <docs> <rounds> <roundTotal...> <n> doc:round:count ...");
    const std::size_t countAt = 3 + static_cast<std::size_t>(rounds);
    std::vector<int> totals;
    for (long long r = 0; r < rounds; ++r) {
      if (a.size() <= 3 + static_cast<std::size_t>(r) || !toInt(a[3 + static_cast<std::size_t>(r)], n1) || n1 < 0) return err("BAD_ARGUMENT", "Bad round total.");
      totals.push_back(static_cast<int>(n1));
    }
    if (!itemsAt(a, countAt, items, error)) return error;
    std::vector<DocCount> cells;
    for (const std::string& it : items) {
      std::vector<std::string> f = splitOn(it, ':');
      long long c;
      if (f.size() != 3 || !toInt(f[0], n1) || !toInt(f[1], n2) || !toInt(f[2], c)) return err("BAD_ARGUMENT", "DOC_READINESS item: doc:round:count");
      cells.push_back(DocCount{static_cast<int>(n1), static_cast<int>(n2), static_cast<int>(c)});
    }
    ReadinessReport r;
    if (!computeDocReadiness(static_cast<int>(docs), static_cast<int>(rounds), totals, cells, r)) return err("BAD_ARGUMENT", "Invalid matrix data.");
    auto num = [](int v) { return std::to_string(v); };
    auto dbl = [](double v) { char b[32]; std::snprintf(b, sizeof b, "%.1f", v); return std::string(b); };
    std::ostringstream o;
    o << "{\"ok\":true,\"docs\":" << r.docs << ",\"rounds\":" << r.rounds << ",\"counts\":" << arrayJson(r.counts, num) << ",\"percent\":" << arrayJson(r.percent, dbl)
      << ",\"docTotals\":" << arrayJson(r.docTotals, num) << ",\"roundTotals\":" << arrayJson(r.roundTotals, num)
      << ",\"weakestDoc\":" << arrayJson(r.weakestDoc, num) << ",\"strongestDoc\":" << arrayJson(r.strongestDoc, num) << "}";
    return o.str();
  }

  // everything else is a Phase 4 queue command (or an error), handled exactly as before
  return handleLine(tk.queue, line, quit);
}

}  // namespace admitflow
