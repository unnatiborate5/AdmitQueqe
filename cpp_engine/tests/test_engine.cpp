// Unit tests for the DSA structures and the queue engine. No external framework.
// Build and run:  make test     (or: npm test, which compiles and runs this file)
#include <cstdio>
#include <functional>
#include <string>
#include <vector>

#include "protocol.hpp"
#include "queue_engine.hpp"

using namespace admitflow;

static int g_checks = 0, g_failed = 0;
#define CHECK(cond)                                                                    \
  do {                                                                                 \
    ++g_checks;                                                                        \
    if (!(cond)) { ++g_failed; std::printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); } \
  } while (0)

static std::vector<std::pair<std::string, std::function<void()>>>& registry() {
  static std::vector<std::pair<std::string, std::function<void()>>> r;
  return r;
}
struct Reg { Reg(const char* n, std::function<void()> f) { registry().push_back({n, f}); } };
#define TEST(name) static void name(); static Reg reg_##name(#name, name); static void name()

// ----- helpers -----
static std::string app(int i) { return "APP-" + std::to_string(1000 + i); }
static std::vector<std::string> order(const QueueEngine& e) {
  std::vector<std::string> out;
  for (const TokenView& v : e.snapshot().waiting) out.push_back(v.token.code);
  return out;
}
static void addCounters(QueueEngine& e) {   // every test starts with counters 1 and 2 open
  e.setCounter(1, true);
  e.setCounter(2, true);
}

// =============================== DSA structures ===============================
TEST(fifo_queue_keeps_arrival_order) {
  FifoQueue<int> q;
  CHECK(q.empty());
  for (int i = 1; i <= 5; ++i) q.push(i);
  CHECK(q.size() == 5);
  CHECK(*q.front() == 1);
  int v = 0;
  for (int i = 1; i <= 5; ++i) { CHECK(q.pop(v)); CHECK(v == i); }
  CHECK(!q.pop(v));
  CHECK(q.empty());
  q.push(9);                      // reusable after being emptied (tail reset)
  CHECK(q.pop(v) && v == 9);
}

TEST(fifo_queue_remove_and_sorted_insert) {
  FifoQueue<int> q;
  for (int i : {1, 3, 5, 7}) q.push(i);
  CHECK(q.removeIf([](int x) { return x == 3 || x == 7; }) == 2);   // middle and tail
  q.insertSorted(4, [](int a, int b) { return a < b; });
  q.insertSorted(0, [](int a, int b) { return a < b; });             // new head
  q.insertSorted(9, [](int a, int b) { return a < b; });             // new tail
  std::vector<int> got;
  q.forEach([&](int x) { got.push_back(x); });
  CHECK((got == std::vector<int>{0, 1, 4, 5, 9}));
  q.push(10);                                                        // tail pointer still right
  q.removeIf([](int x) { return x == 0; });                          // remove head
  int v = 0; q.pop(v);
  CHECK(v == 1);
}

struct IntLess { bool operator()(int a, int b) const { return a < b; } };
TEST(min_heap_pops_in_sorted_order) {
  MinHeap<int, IntLess> h;
  int input[] = {50, 20, 40, 10, 30, 20, 60, 5, 5};
  for (int x : input) h.push(x);
  CHECK(h.size() == 9);
  CHECK(*h.top() == 5);
  std::vector<int> got;
  int v;
  while (h.pop(v)) got.push_back(v);
  CHECK((got == std::vector<int>{5, 5, 10, 20, 20, 30, 40, 50, 60}));
  CHECK(h.top() == nullptr);
  CHECK(!h.pop(v));
}

TEST(hash_map_put_find_erase_and_rehash) {
  HashMap<std::string, int, StringHash> m(4);
  for (int i = 0; i < 1000; ++i) m.put("key" + std::to_string(i), i);   // forces many rehashes
  CHECK(m.size() == 1000);
  CHECK(m.bucketCount() >= 1000 * 4 / 3);                                // load factor stays <= 0.75
  bool allFound = true;
  for (int i = 0; i < 1000; ++i) { const int* p = m.find("key" + std::to_string(i)); if (!p || *p != i) allFound = false; }
  CHECK(allFound);
  CHECK(m.find("nope") == nullptr);
  m.put("key5", 555);                                                    // overwrite, not duplicate
  CHECK(m.size() == 1000 && *m.find("key5") == 555);
  int* stable = m.find("key7");
  for (int i = 2000; i < 2500; ++i) m.put("key" + std::to_string(i), i); // pointers survive rehash
  CHECK(stable == m.find("key7") && *stable == 7);
  for (int i = 0; i < 1000; i += 2) CHECK(m.erase("key" + std::to_string(i)));
  CHECK(!m.erase("key0"));
  CHECK(m.size() == 1000);   // 1000 + 500 inserted - 500 erased
  CHECK(!m.contains("key10") && m.contains("key11"));
  std::size_t visited = 0;
  m.forEach([&](const std::string&, int) { ++visited; });
  CHECK(visited == m.size());
}

TEST(hash_map_with_int_keys) {
  HashMap<long long, std::string, IntHash> m;
  for (long long i = 1; i <= 100; ++i) m.put(i, "c" + std::to_string(i));
  CHECK(*m.find(42) == "c42");
  CHECK(m.find(0) == nullptr);
}

// ============================== token generation ==============================
TEST(tokens_are_unique_and_sequential) {
  QueueEngine e(3); addCounters(e);
  Result a = e.enqueue(3, 1, app(1));
  Result b = e.enqueue(1, 2, app(2));
  Result c = e.enqueue(3, 3, app(3));
  CHECK(a.ok && b.ok && c.ok);
  CHECK(a.token.token.code == "R001");
  CHECK(b.token.token.code == "P002");      // priority lane letter, but the arrival number keeps counting
  CHECK(c.token.token.code == "R003");
  CHECK(a.token.token.seq == 1 && b.token.token.seq == 2 && c.token.token.seq == 3);
  CHECK(QueueEngine::makeCode(3, 1234) == "R1234");
}

TEST(bad_arguments_are_rejected) {
  QueueEngine e(3); addCounters(e);
  CHECK(!e.enqueue(0, 1, app(1)).ok);
  CHECK(!e.enqueue(4, 1, app(1)).ok);
  CHECK(!e.enqueue(3, 1, "").ok);
  CHECK(!e.setCounter(0, true).ok);
  CHECK(e.callNext(99).error == "UNKNOWN_COUNTER");
}

// =============================== duplicate prevention ===============================
TEST(duplicate_active_token_is_refused_in_o1) {
  QueueEngine e(3); addCounters(e);
  CHECK(e.enqueue(3, 1, app(1)).ok);
  Result dup = e.enqueue(1, 1, app(1));                 // even with a different priority
  CHECK(!dup.ok && dup.error == "DUPLICATE_TOKEN");
  CHECK(dup.hasToken && dup.token.token.code == "R001");   // tells the caller which token already exists
  CHECK(e.snapshot().waiting.size() == 1);
  CHECK(e.snapshot().lastSeq == 1);                     // no arrival number was burned
  // still blocked while called and while being served
  e.callNext(1);
  CHECK(e.enqueue(3, 1, app(1)).error == "DUPLICATE_TOKEN");
  e.start("R001");
  CHECK(e.enqueue(3, 1, app(1)).error == "DUPLICATE_TOKEN");
  // allowed again once the token has finished
  CHECK(e.complete("R001").ok);
  Result again = e.enqueue(3, 1, app(1));
  CHECK(again.ok && again.token.token.code == "R002");
}

// =============================== FIFO and priority ===============================
TEST(regular_students_are_served_first_come_first_served) {
  QueueEngine e(3); addCounters(e);
  for (int i = 1; i <= 4; ++i) e.enqueue(3, i, app(i));
  CHECK((order(e) == std::vector<std::string>{"R001", "R002", "R003", "R004"}));
  CHECK(e.callNext(1).token.token.code == "R001");
  CHECK(e.callNext(2).token.token.code == "R002");
  CHECK((order(e) == std::vector<std::string>{"R003", "R004"}));
}

TEST(priority_students_go_before_regular_ones) {
  QueueEngine e(3); addCounters(e);
  e.enqueue(3, 1, app(1));          // R001
  e.enqueue(3, 2, app(2));          // R002
  e.enqueue(2, 3, app(3));          // P003  (level 2)
  e.enqueue(1, 4, app(4));          // P004  (level 1, arrived last but most urgent)
  CHECK((order(e) == std::vector<std::string>{"P004", "P003", "R001", "R002"}));
  CHECK(e.callNext(1).token.token.code == "P004");
  CHECK(e.callNext(2).token.token.code == "P003");
}

TEST(same_priority_level_keeps_arrival_order) {
  QueueEngine e(100); addCounters(e);
  for (int i = 1; i <= 6; ++i) e.enqueue(2, i, app(i));
  std::vector<std::string> got;
  for (int i = 0; i < 6; ++i) {
    Result r = e.callNext(1);
    got.push_back(r.token.token.code);
    e.start(r.token.token.code);
    e.complete(r.token.token.code);
  }
  CHECK((got == std::vector<std::string>{"P001", "P002", "P003", "P004", "P005", "P006"}));
}

TEST(fairness_rule_prevents_regular_lane_starvation) {
  QueueEngine e(2); addCounters(e);                      // after 2 priority calls, one regular call
  e.enqueue(3, 1, app(1));                              // R001
  for (int i = 2; i <= 6; ++i) e.enqueue(1, i, app(i)); // P002..P006
  CHECK((order(e) == std::vector<std::string>{"P002", "P003", "R001", "P004", "P005", "P006"}));
  std::vector<std::string> served;
  for (int i = 0; i < 6; ++i) {
    Result r = e.callNext(1);
    served.push_back(r.token.token.code);
    e.start(r.token.token.code);
    e.complete(r.token.token.code);
  }
  CHECK((served == std::vector<std::string>{"P002", "P003", "R001", "P004", "P005", "P006"}));
}

TEST(projected_order_always_matches_the_real_call_order) {
  QueueEngine e(3); addCounters(e);
  for (int i = 1; i <= 12; ++i) e.enqueue(i % 4 == 0 ? 1 : (i % 3 == 0 ? 2 : 3), i, app(i));
  std::vector<std::string> promised = order(e);
  std::vector<std::string> actual;
  for (std::size_t i = 0; i < promised.size(); ++i) {
    Result r = e.callNext(1);
    CHECK(r.ok);
    actual.push_back(r.token.token.code);
    e.start(r.token.token.code);
    e.complete(r.token.token.code);
  }
  CHECK(promised == actual);
}

TEST(position_and_ahead_are_reported_for_a_waiting_token) {
  QueueEngine e(3); addCounters(e);
  e.enqueue(3, 1, app(1));
  e.enqueue(3, 2, app(2));
  e.enqueue(1, 3, app(3));
  Result r = e.findByCode("R002");
  CHECK(r.ok && r.token.position == 3 && r.token.ahead == 2);
  e.callNext(1);                                        // P003 leaves the queue
  r = e.findByCode("R002");
  CHECK(r.token.position == 2);
  e.callNext(2);
  CHECK(e.findByCode("R002").token.position == 1);
  e.callNext(1) /* busy */;
}

// =============================== lookups ===============================
TEST(lookup_by_token_code_and_by_application_id) {
  QueueEngine e(3); addCounters(e);
  e.enqueue(3, 11, app(1));
  e.enqueue(1, 22, app(2));
  Result a = e.findByCode("P002");
  CHECK(a.ok && a.token.token.studentId == 22 && a.token.token.appId == app(2));
  Result b = e.findByApplication(app(1));
  CHECK(b.ok && b.token.token.code == "R001" && b.token.token.studentId == 11);
  CHECK(e.findByCode("R999").error == "NOT_FOUND");
  CHECK(e.findByApplication("APP-0").error == "NOT_FOUND");
  e.callNext(1);
  CHECK(e.findByApplication(app(2)).token.token.status == Status::Called);
  e.start("P002"); e.complete("P002");
  CHECK(e.findByApplication(app(2)).error == "NOT_FOUND");   // finished tokens leave the engine
}

// =============================== multiple counters ===============================
TEST(two_counters_share_one_queue_without_serving_the_same_student) {
  QueueEngine e(3); addCounters(e);
  for (int i = 1; i <= 4; ++i) e.enqueue(3, i, app(i));
  Result a = e.callNext(1), b = e.callNext(2);
  CHECK(a.ok && b.ok && a.token.token.code != b.token.token.code);
  CHECK(a.token.token.counterId == 1 && b.token.token.counterId == 2);
  CHECK(e.callNext(1).error == "COUNTER_BUSY");          // a counter holds one student at a time
  CHECK(e.callNext(2).error == "COUNTER_BUSY");
  e.start("R001"); e.complete("R001");
  Result c = e.callNext(1);                              // freed counter takes the next in line
  CHECK(c.ok && c.token.token.code == "R003");
  Snapshot s = e.snapshot();
  CHECK(s.counters.size() == 2 && s.counters[0].hasToken && s.counters[1].hasToken);
  CHECK(s.waiting.size() == 1 && s.called == 2);
}

TEST(closed_counter_cannot_call_and_unknown_queue_is_empty) {
  QueueEngine e(3); addCounters(e);
  e.setCounter(2, false);
  e.enqueue(3, 1, app(1));
  CHECK(e.callNext(2).error == "COUNTER_CLOSED");
  CHECK(e.callNext(1).ok);
  CHECK(e.callNext(1).error == "COUNTER_BUSY");
  e.setCounter(2, true);
  CHECK(e.callNext(2).error == "QUEUE_EMPTY");
}

TEST(closing_a_counter_returns_a_called_student_to_their_original_place) {
  QueueEngine e(100); addCounters(e);
  for (int i = 1; i <= 4; ++i) e.enqueue(3, i, app(i));   // R001..R004
  e.callNext(1);                                           // R001 -> counter 1
  e.callNext(2);                                           // R002 -> counter 2
  Result r1 = e.setCounter(1, false);                      // R001 comes back...
  CHECK(r1.ok && r1.returned.size() == 1 && r1.returned[0].token.code == "R001" && r1.returned[0].position == 1);
  Result r2 = e.setCounter(2, false);                      // ...then R002: still behind R001
  CHECK(r2.ok && r2.returned.size() == 1);
  CHECK((order(e) == std::vector<std::string>{"R001", "R002", "R003", "R004"}));
  CHECK(e.snapshot().called == 0);
}

TEST(closing_a_busy_counter_is_refused) {
  QueueEngine e(3); addCounters(e);
  e.enqueue(3, 1, app(1));
  e.callNext(1); e.start("R001");
  CHECK(e.setCounter(1, false).error == "COUNTER_BUSY");
  CHECK(e.snapshot().counters[0].open);
}

TEST(returned_priority_student_goes_back_into_the_heap) {
  QueueEngine e(100); addCounters(e);
  e.enqueue(1, 1, app(1));    // P001
  e.enqueue(1, 2, app(2));    // P002
  e.callNext(1);              // P001
  e.setCounter(1, false);
  CHECK((order(e) == std::vector<std::string>{"P001", "P002"}));
}

// =============================== completion / no-show / cancel ===============================
TEST(state_transitions_are_enforced) {
  QueueEngine e(3); addCounters(e);
  e.enqueue(3, 1, app(1));
  CHECK(e.start("R001").error == "BAD_STATE");           // cannot serve a student who was never called
  CHECK(e.complete("R001").error == "BAD_STATE");
  CHECK(e.noShow("R001").error == "BAD_STATE");
  e.callNext(1);
  CHECK(e.complete("R001").error == "BAD_STATE");        // called but not yet serving
  CHECK(e.start("R001").ok);
  CHECK(e.start("R001").error == "BAD_STATE");
  CHECK(e.noShow("R001").error == "BAD_STATE");          // a student already being served cannot be a no-show
  CHECK(e.cancel("R001").error == "BAD_STATE");
  Result done = e.complete("R001");
  CHECK(done.ok && done.token.finalStatus == "completed");
  CHECK(e.complete("R001").error == "NOT_FOUND");
}

TEST(no_show_frees_the_counter_and_the_student_can_get_a_new_token) {
  QueueEngine e(3); addCounters(e);
  e.enqueue(3, 1, app(1));
  e.enqueue(3, 2, app(2));
  e.callNext(1);
  Result ns = e.noShow("R001");
  CHECK(ns.ok && ns.token.finalStatus == "no_show");
  CHECK(e.snapshot().counters[0].hasToken == false);
  CHECK(e.callNext(1).token.token.code == "R002");       // counter immediately usable again
  Result back = e.enqueue(3, 1, app(1));                 // re-check-in is allowed after a no-show
  CHECK(back.ok && back.token.token.code == "R003" && back.token.position == 1);   // at the back, nobody is skipped
}

TEST(cancelled_waiting_students_disappear_from_both_lanes) {
  QueueEngine e(100); addCounters(e);
  e.enqueue(3, 1, app(1));    // R001
  e.enqueue(1, 2, app(2));    // P002
  e.enqueue(1, 3, app(3));    // P003
  e.enqueue(3, 4, app(4));    // R004
  CHECK(e.cancel("P002").ok);                             // lazy deletion in the heap
  CHECK(e.cancel("R001").ok);                             // eager removal from the FIFO
  CHECK((order(e) == std::vector<std::string>{"P003", "R004"}));
  Snapshot s = e.snapshot();
  CHECK(s.priorityWaiting == 1 && s.regularWaiting == 1);
  CHECK(e.callNext(1).token.token.code == "P003");        // the stale heap entry for P002 is skipped
  CHECK(e.callNext(2).token.token.code == "R004");
  CHECK(e.callNext(1).error == "COUNTER_BUSY");
  CHECK(e.findByCode("P002").error == "NOT_FOUND");
  CHECK(e.enqueue(3, 2, app(2)).ok);                      // cancelled student may queue again
}

TEST(cancelling_a_called_student_frees_their_counter) {
  QueueEngine e(3); addCounters(e);
  e.enqueue(3, 1, app(1));
  e.callNext(1);
  CHECK(e.cancel("R001").ok);
  CHECK(!e.snapshot().counters[0].hasToken);
}

// =============================== restore ===============================
TEST(engine_can_be_rebuilt_from_persisted_tokens) {
  QueueEngine a(3); addCounters(a);
  a.enqueue(3, 1, app(1)); a.enqueue(1, 2, app(2)); a.enqueue(3, 3, app(3)); a.enqueue(2, 4, app(4)); a.enqueue(3, 5, app(5));
  a.callNext(1);                         // P002 -> counter 1 (called)
  a.start("P002");                       // serving
  a.callNext(2);                         // P004 -> counter 2 (called)
  const std::vector<std::string> before = order(a);
  const int streakBefore = a.streak();

  // simulate a restart: new engine, load every active token from the "database"
  QueueEngine b(3);
  b.setCounter(1, true); b.setCounter(2, true);
  Snapshot s = a.snapshot();
  std::vector<TokenView> all = s.waiting;
  for (const CounterView& c : s.counters) if (c.hasToken) all.push_back(c.token);
  for (const TokenView& v : all) CHECK(b.load(v.token).ok);
  b.setStreak(streakBefore);
  CHECK(order(b) == before);
  CHECK(b.snapshot().lastSeq == 5);
  CHECK(b.enqueue(3, 6, app(6)).token.token.code == "R006");     // arrival numbers continue
  CHECK(b.enqueue(3, 1, app(1)).error == "DUPLICATE_TOKEN");      // duplicate guard survives the restart
  CHECK(b.snapshot().serving == 1 && b.snapshot().called == 1);
  CHECK(b.complete("P002").ok);
}

TEST(load_rejects_inconsistent_data) {
  QueueEngine e(3); addCounters(e);
  Token t; t.seq = 1; t.level = 3; t.status = Status::Waiting; t.studentId = 1; t.appId = app(1);
  CHECK(e.load(t).ok);
  CHECK(e.load(t).error == "DUPLICATE_TOKEN");
  Token t2; t2.seq = 2; t2.level = 3; t2.status = Status::Called; t2.counterId = 7; t2.appId = app(2);
  CHECK(e.load(t2).error == "UNKNOWN_COUNTER");
}

// =============================== protocol ===============================
TEST(protocol_parses_commands_and_survives_garbage) {
  QueueEngine e(3);
  bool quit = false;
  auto run = [&](const std::string& l) { return handleLine(e, l, quit); };
  CHECK(run("COUNTER 1 1").find("\"ok\":true") != std::string::npos);
  std::string r = run("ENQUEUE 3 7 MH2026-1");
  CHECK(r.find("\"code\":\"R001\"") != std::string::npos && r.find("\"position\":1") != std::string::npos);
  CHECK(run("ENQUEUE 3 8 MH2026-1").find("DUPLICATE_TOKEN") != std::string::npos);
  CHECK(run("ENQUEUE x y z").find("BAD_ARGUMENT") != std::string::npos);
  CHECK(run("ENQUEUE 3").find("BAD_ARGUMENT") != std::string::npos);
  CHECK(run("CALL 1").find("\"status\":\"called\"") != std::string::npos);
  CHECK(run("").find("BAD_COMMAND") != std::string::npos);
  CHECK(run("DROP TABLE").find("BAD_COMMAND") != std::string::npos);
  CHECK(run("FIND_APP MH2026-1").find("\"counterId\":1") != std::string::npos);
  CHECK(run("SNAPSHOT").find("\"counters\":[{\"id\":1") != std::string::npos);
  CHECK(!quit);
  run("QUIT");
  CHECK(quit);
}

int main() {
  int failedTests = 0;
  for (auto& t : registry()) {
    int before = g_failed;
    t.second();
    std::printf("%s %s\n", g_failed == before ? "PASS" : "FAIL", t.first.c_str());
    if (g_failed != before) ++failedTests;
  }
  std::printf("\n%d tests, %d checks, %d failed\n", static_cast<int>(registry().size()), g_checks, g_failed);
  return g_failed == 0 ? 0 : 1;
}
