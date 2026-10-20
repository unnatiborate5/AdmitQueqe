// Unit tests for the Phase 5 syllabus features: merge sort, binary/linear search, stack, dense and sparse matrices,
// the search index, the planner, the undo stacks, the matrix reports and the protocol layer.
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <string>
#include <vector>

#include "algo/merge_sort.hpp"
#include "algo/search.hpp"
#include "dsa/dense_matrix.hpp"
#include "dsa/sparse_matrix.hpp"
#include "dsa/stack.hpp"
#include "planner.hpp"
#include "reports.hpp"
#include "search_index.hpp"
#include "toolkit.hpp"
#include "undo_stacks.hpp"

using namespace admitflow;

static int g_checks = 0, g_failed = 0;
#define CHECK(cond)                                                                    \
  do {                                                                                 \
    ++g_checks;                                                                        \
    if (!(cond)) { ++g_failed; std::printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); } \
  } while (0)
static std::vector<std::pair<std::string, std::function<void()>>>& registry() { static std::vector<std::pair<std::string, std::function<void()>>> r; return r; }
struct Reg { Reg(const char* n, std::function<void()> f) { registry().push_back({n, f}); } };
#define TEST(name) static void name(); static Reg reg_##name(#name, name); static void name()

static unsigned rng_state = 12345;
static unsigned rnd() { rng_state = rng_state * 1103515245u + 12345u; return (rng_state >> 16) & 0x7fff; }

// ================================ SORTING ================================
TEST(merge_sort_sorts_ints_and_handles_edge_sizes) {
  std::vector<int> empty; CHECK(mergeSort(empty, [](int a, int b) { return a < b; }) == 0 && empty.empty());
  std::vector<int> one{5}; mergeSort(one, [](int a, int b) { return a < b; }); CHECK(one == std::vector<int>{5});
  std::vector<int> v{5, 2, 9, 1, 5, 6, 0, -3, 7};
  mergeSort(v, [](int a, int b) { return a < b; });
  CHECK((v == std::vector<int>{-3, 0, 1, 2, 5, 5, 6, 7, 9}));
  std::vector<int> d{1, 2, 3, 4};
  mergeSort(d, [](int a, int b) { return a > b; });                    // descending
  CHECK((d == std::vector<int>{4, 3, 2, 1}));
}

struct Rec { int key; int order; };
TEST(merge_sort_is_stable) {
  std::vector<Rec> v;
  for (int i = 0; i < 300; ++i) v.push_back(Rec{static_cast<int>(rnd() % 5), i});   // many ties
  mergeSort(v, [](const Rec& a, const Rec& b) { return a.key < b.key; });
  bool stable = true;
  for (std::size_t i = 1; i < v.size(); ++i) {
    if (v[i - 1].key > v[i].key) stable = false;
    if (v[i - 1].key == v[i].key && v[i - 1].order > v[i].order) stable = false;   // equal keys keep input order
  }
  CHECK(stable);
}

TEST(merge_sort_matches_the_standard_library_on_random_data) {
  for (int round = 0; round < 40; ++round) {
    std::vector<int> a; const int n = static_cast<int>(rnd() % 200);
    for (int i = 0; i < n; ++i) a.push_back(static_cast<int>(rnd() % 1000) - 500);
    std::vector<int> b = a;
    mergeSort(a, [](int x, int y) { return x < y; });
    std::stable_sort(b.begin(), b.end());
    CHECK(a == b);
  }
}

TEST(merge_sort_comparison_count_is_n_log_n) {
  std::vector<int> v;
  for (int i = 0; i < 1024; ++i) v.push_back(static_cast<int>(rnd()));
  const std::size_t c = mergeSort(v, [](int a, int b) { return a < b; });
  CHECK(c <= 1024u * 10u);       // n log2 n upper bound
  CHECK(c >= 1024u * 4u);        // and it is not trivially small
  std::vector<int> sorted(1024); for (int i = 0; i < 1024; ++i) sorted[static_cast<std::size_t>(i)] = i;
  CHECK(mergeSort(sorted, [](int a, int b) { return a < b; }) <= 1024u * 10u / 2u + 1024u);   // no quadratic blow-up on sorted input
}

// ================================ SEARCHING ================================
TEST(binary_search_bounds_match_std) {
  std::vector<int> v;
  for (int i = 0; i < 500; ++i) v.push_back(static_cast<int>(rnd() % 100));
  std::sort(v.begin(), v.end());
  for (int key = -2; key < 105; ++key) {
    std::size_t c1 = 0, c2 = 0;
    std::size_t lo = lowerBound(v, key, [](int e, int k) { return e < k; }, c1);
    std::size_t hi = upperBound(v, key, [](int k, int e) { return k < e; }, c2);
    CHECK(lo == static_cast<std::size_t>(std::lower_bound(v.begin(), v.end(), key) - v.begin()));
    CHECK(hi == static_cast<std::size_t>(std::upper_bound(v.begin(), v.end(), key) - v.begin()));
  }
}

TEST(binary_search_takes_log_n_steps_and_linear_search_takes_n) {
  std::vector<int> v; for (int i = 0; i < 1000; ++i) v.push_back(i * 2);
  std::size_t steps = 0;
  const std::size_t pos = lowerBound(v, 777 * 2, [](int e, int k) { return e < k; }, steps);
  CHECK(pos == 777 && steps <= 10);                       // ceil(log2 1000) = 10
  std::size_t scans = 0;
  auto hits = linearSearchAll(v, [](int e) { return e == 1554; }, scans);
  CHECK(hits.size() == 1 && hits[0] == 777 && scans == 1000);   // linear search must look at everything
  std::vector<int> none;
  std::size_t c = 0;
  CHECK(lowerBound(none, 1, [](int e, int k) { return e < k; }, c) == 0 && c == 0);
}

TEST(search_index_finds_by_application_id_prefix_token_and_name) {
  SearchIndex ix;
  ix.addStudent(1, "mh2026-10002", "Meera Kulkarni");
  ix.addStudent(2, "MH2026-10001", "Aarav Deshmukh");
  ix.addStudent(3, "MH2026-10010", "Ravi Kale");
  ix.addStudent(4, "MH2027-20000", "Kavita Kulkarni");
  ix.addToken(7, 'P', 3); ix.addToken(2, 'R', 1); ix.addToken(5, 'R', 4);
  CHECK(!ix.built());
  ix.build();
  CHECK(ix.built());
  SearchStats st;
  auto exact = ix.findByApplicationPrefix("mh2026-10010", st);      // exact ID, case-insensitive
  CHECK(exact == std::vector<long long>{3} && st.algorithm == "binary search");
  auto pre = ix.findByApplicationPrefix("MH2026-100", st);          // prefix range, in ID order
  CHECK((pre == std::vector<long long>{2, 1, 3}));
  CHECK((ix.findByApplicationPrefix("MH2026", st) == std::vector<long long>{2, 1, 3}));
  CHECK((ix.findByApplicationPrefix("MH", st).size() == 4));
  CHECK(ix.findByApplicationPrefix("XX", st).empty());
  CHECK(ix.findByApplicationPrefix("MH2026-10011", st).empty());
  CHECK(ix.findByApplicationPrefix("", st).empty());
  long long id = 0;
  CHECK(ix.findToken("p007", id, st) && id == 3);
  CHECK(ix.findToken("R002", id, st) && id == 1);
  CHECK(!ix.findToken("R007", id, st));                              // number exists but lane differs
  CHECK(!ix.findToken("P999", id, st) && !ix.findToken("R", id, st) && !ix.findToken("Rx1", id, st));
  auto byName = ix.findByName("KUL", st);                            // substring, case-insensitive
  CHECK(st.algorithm == "linear search" && st.comparisons == 4);     // examined every record
  CHECK(byName.size() == 2);
  CHECK(ix.findByName("zzz", st).empty() && ix.findByName("", st).empty());
}

TEST(search_index_binary_search_scales_logarithmically) {
  SearchIndex ix;
  for (int i = 0; i < 4000; ++i) {
    char buf[32]; std::snprintf(buf, sizeof buf, "MH2026-%05d", 10000 + (i * 7919) % 4000);   // shuffled insertion order
    ix.addStudent(i, buf, "Student " + std::to_string(i));
  }
  ix.build();
  SearchStats st;
  auto hit = ix.findByApplicationPrefix("MH2026-11234", st);
  CHECK(hit.size() == 1);
  CHECK(st.comparisons <= 2 * 12 + 2);                    // two binary searches over 4000 records: ~12 steps each
  ix.findByName("student 3999", st);
  CHECK(st.comparisons == 4000);                          // the linear alternative reads every record
}

// ================================ PLANNER (sorting feature) ================================
static WorkItem W(long long id, int level, int minutes, int token, long long wait, const char* name) {
  WorkItem w; w.id = id; w.level = level; w.minutes = minutes; w.token = token; w.waitKey = wait; w.name = name; return w;
}
static std::vector<long long> ids(const std::vector<WorkItem>& v) { std::vector<long long> o; for (const auto& w : v) o.push_back(w.id); return o; }

TEST(planner_ranks_unscheduled_students_by_priority_then_waiting_time) {
  std::vector<WorkItem> v{W(1, 3, 0, 0, 100, "zed"), W(2, 2, 0, 0, 500, "amy"), W(3, 1, 0, 0, 900, "bob"), W(4, 3, 0, 0, 50, "cat"), W(5, 2, 0, 0, 500, "abe")};
  sortWork(v, SortMode::Unscheduled);
  // level 1 first; level 2 by longer wait (equal -> name); level 3 by longer wait
  CHECK((ids(v) == std::vector<long long>{3, 5, 2, 4, 1}));
}

TEST(planner_orders_todays_arrivals_by_time_priority_or_token) {
  std::vector<WorkItem> base{W(1, 3, 600, 4, 0, "dev"), W(2, 1, 630, 0, 0, "anu"), W(3, 2, 600, 2, 0, "bea"), W(4, 3, 570, 0, 0, "cy"), W(5, 3, 600, 0, 0, "abe")};
  auto t = base; sortWork(t, SortMode::ArrivalsTime);
  CHECK((ids(t) == std::vector<long long>{4, 3, 5, 1, 2}));           // 09:30, then 10:00 by level (2,3,3: abe<dev), then 10:30
  auto p = base; sortWork(p, SortMode::ArrivalsPriority);
  CHECK((ids(p) == std::vector<long long>{2, 3, 4, 5, 1}));           // level 1, level 2, then level 3 by time
  auto k = base; sortWork(k, SortMode::ArrivalsToken);
  CHECK((ids(k) == std::vector<long long>{3, 1, 4, 5, 2}));           // tokens 2 and 4 first; students not checked in last, by time
  SortMode m;
  CHECK(parseSortMode("arrivals_token", m) && !parseSortMode("bubble", m));
}

TEST(planner_sort_is_stable_for_complete_ties) {
  std::vector<WorkItem> v;
  for (int i = 1; i <= 50; ++i) v.push_back(W(i, 3, 600, 0, 10, "same"));
  sortWork(v, SortMode::Unscheduled);
  bool inOrder = true; for (int i = 0; i < 50; ++i) if (v[static_cast<std::size_t>(i)].id != i + 1) inOrder = false;
  CHECK(inOrder);
}

// ================================ STACK ================================
TEST(stack_is_last_in_first_out) {
  Stack<int> s;
  CHECK(s.empty() && s.peek() == nullptr);
  int out = 0; CHECK(!s.pop(out));
  s.push(1); s.push(2); s.push(3);
  CHECK(s.size() == 3 && *s.peek() == 3);
  CHECK(s.pop(out) && out == 3);
  CHECK(s.pop(out) && out == 2);
  s.push(9);                                    // new top
  CHECK(*s.peek() == 9);
  CHECK(s.pop(out) && out == 9);
  CHECK(s.pop(out) && out == 1);
  CHECK(s.empty() && !s.pop(out));
}

TEST(bounded_stack_discards_the_oldest_entry) {
  Stack<int> s(3);
  int dropped = -1;
  CHECK(!s.push(1, &dropped) && !s.push(2, &dropped) && !s.push(3, &dropped));
  CHECK(s.push(4, &dropped) && dropped == 1);   // the bottom is discarded, not the top
  CHECK(s.size() == 3 && *s.peek() == 4);
  std::vector<int> seen; s.forEachTopDown([&](int x) { seen.push_back(x); });
  CHECK((seen == std::vector<int>{4, 3, 2}));
  s.clear(); CHECK(s.empty());
}

TEST(undo_stacks_are_separate_per_admin_and_lifo) {
  UndoStacks u(3);
  UndoEntry dropped;
  u.push(1, UndoEntry{10, 100, "review"}, &dropped);
  u.push(1, UndoEntry{11, 101, "reschedule"}, &dropped);
  u.push(2, UndoEntry{20, 200, "review"}, &dropped);
  CHECK(u.size(1) == 2 && u.size(2) == 1 && u.size(3) == 0);
  CHECK(u.peek(1)->actionId == 11 && u.peek(2)->actionId == 20 && u.peek(3) == nullptr);
  UndoEntry e;
  CHECK(u.pop(1, e) && e.actionId == 11 && e.kind == "reschedule");   // newest first
  CHECK(u.pop(1, e) && e.actionId == 10);
  CHECK(!u.pop(1, e));
  CHECK(u.size(2) == 1);                                              // admin 2 untouched
  for (int i = 0; i < 4; ++i) u.push(5, UndoEntry{30 + i, 0, "x"}, &dropped);
  CHECK(u.size(5) == 3 && dropped.actionId == 30);                    // capacity 3: oldest fell off
  CHECK(u.list(5).front().actionId == 33 && u.list(5).back().actionId == 31);
  u.clearAll(); CHECK(u.size(2) == 0);
}

// ================================ MATRICES ================================
TEST(dense_matrix_access_sums_and_extremes) {
  DenseMatrix<int> m(3, 2);
  for (int r = 0; r < 3; ++r) for (int c = 0; c < 2; ++c) m.at(static_cast<std::size_t>(r), static_cast<std::size_t>(c)) = (r + 1) * 10 + c;
  CHECK(m.at(2, 1) == 31 && m.rows() == 3 && m.cols() == 2);
  CHECK(m.rowSum(0) == 21 && m.colSum(1) == 11 + 21 + 31);
  CHECK(m.argMinInColumn(0) == 0 && m.argMaxInColumn(0) == 2);
  bool threw = false; try { m.at(3, 0); } catch (const std::out_of_range&) { threw = true; }
  CHECK(threw);
}

TEST(sparse_matrix_stores_only_non_zero_cells_in_sorted_order) {
  SparseMatrix<int> m(31, 48);
  m.add(5, 20, 1); m.add(0, 30, 2); m.add(5, 19, 1); m.add(30, 47, 4); m.add(5, 20, 1);   // 5,20 accumulates
  CHECK(m.nonZeros() == 4);
  CHECK(m.get(5, 20) == 2 && m.get(0, 30) == 2 && m.get(30, 47) == 4);
  CHECK(m.get(1, 1) == 0 && m.get(5, 21) == 0);                       // absent cells read as 0
  const auto& e = m.entries();
  bool sorted = true;
  for (std::size_t i = 1; i < e.size(); ++i) if (e[i - 1].row > e[i].row || (e[i - 1].row == e[i].row && e[i - 1].col >= e[i].col)) sorted = false;
  CHECK(sorted);
  CHECK(m.density() < 0.01);                                          // 4 of 1488 cells
  m.add(5, 20, -2);                                                   // back to zero: entry is removed
  CHECK(m.nonZeros() == 3 && m.get(5, 20) == 0);
  m.add(2, 2, 0);                                                     // adding zero never creates an entry
  CHECK(m.nonZeros() == 3);
  bool threw = false; try { m.add(31, 0, 1); } catch (const std::out_of_range&) { threw = true; }
  CHECK(threw);
}

TEST(sparse_matrix_sums_and_lookup_cost) {
  SparseMatrix<int> m(10, 20);
  m.add(0, 0, 1); m.add(0, 5, 2); m.add(3, 5, 4); m.add(9, 19, 1);
  auto rs = m.rowSums(), cs = m.colSums();
  CHECK(rs[0] == 3 && rs[3] == 4 && rs[9] == 1 && rs[1] == 0);
  CHECK(cs[5] == 6 && cs[0] == 1 && cs[19] == 1);
  SparseMatrix<int> big(400, 400);
  for (int i = 0; i < 1000; ++i) big.add(static_cast<int>(rnd() % 400), static_cast<int>(rnd() % 400), 1);
  const std::size_t before = big.lookupComparisons();
  big.get(200, 200);
  CHECK(big.lookupComparisons() - before <= 11);                      // log2(~1000 stored cells)
}

TEST(sparse_matrix_agrees_with_a_dense_reference) {
  SparseMatrix<int> sp(20, 30);
  DenseMatrix<int> dn(20, 30);
  for (int i = 0; i < 500; ++i) {
    int r = static_cast<int>(rnd() % 20), c = static_cast<int>(rnd() % 30), d = static_cast<int>(rnd() % 3) - 1;
    sp.add(r, c, d);
    dn.at(static_cast<std::size_t>(r), static_cast<std::size_t>(c)) += d;
  }
  bool same = true;
  for (int r = 0; r < 20; ++r) for (int c = 0; c < 30; ++c) if (sp.get(r, c) != dn.at(static_cast<std::size_t>(r), static_cast<std::size_t>(c))) same = false;
  CHECK(same);
  for (const auto& e : sp.entries()) CHECK(e.value != 0);
}

TEST(appointment_load_report_finds_busy_and_free_slots) {
  // 3 days x 48 half-hour slots; office hours = slots 18..33 (09:00-17:00)
  std::vector<std::pair<int, int>> b{{0, 21}, {0, 21}, {0, 21}, {0, 22}, {1, 21}, {2, 40}};
  LoadReport r;
  CHECK(computeAppointmentLoad(3, 48, 18, 34, b, r));
  CHECK(r.nonZeros == 4 && r.cells.size() == 4);
  CHECK(r.rowSums[0] == 4 && r.rowSums[1] == 1 && r.rowSums[2] == 1);
  CHECK(r.colSums[21] == 4 && r.colSums[22] == 1 && r.colSums[40] == 1);
  CHECK(r.busiest[0].row == 0 && r.busiest[0].col == 21 && r.busiest[0].count == 3);
  CHECK(r.bestSlots[0].col == 18 && r.bestSlots[0].count == 0);       // earliest empty slot inside office hours
  CHECK(r.bestSlots[2].col == 18);                                    // slot 40 is outside office hours and does not matter
  // when every slot of a day is taken, the least-loaded one is suggested
  std::vector<std::pair<int, int>> full; for (int c = 18; c < 34; ++c) { full.push_back({0, c}); if (c != 25) full.push_back({0, c}); }
  LoadReport f; CHECK(computeAppointmentLoad(1, 48, 18, 34, full, f));
  CHECK(f.bestSlots[0].col == 25 && f.bestSlots[0].count == 1);
  CHECK(!computeAppointmentLoad(3, 48, 18, 34, {{3, 0}}, r));         // outside the grid
  CHECK(!computeAppointmentLoad(3, 48, 34, 18, {}, r));               // bad range
}

TEST(document_readiness_report_uses_a_dense_matrix) {
  // 3 documents x 2 rounds; round totals 4 and 2 students
  std::vector<DocCount> cells{{0, 0, 4}, {1, 0, 2}, {2, 0, 1}, {0, 1, 2}, {1, 1, 0}, {2, 1, 1}};
  ReadinessReport r;
  CHECK(computeDocReadiness(3, 2, {4, 2}, cells, r));
  CHECK((r.counts == std::vector<int>{4, 2, 2, 0, 1, 1}));
  CHECK(std::fabs(r.percent[0] - 100.0) < 1e-9 && std::fabs(r.percent[2] - 50.0) < 1e-9 && std::fabs(r.percent[4] - 25.0) < 1e-9);
  CHECK((r.docTotals == std::vector<int>{6, 2, 2}));
  CHECK(r.weakestDoc[0] == 2 && r.weakestDoc[1] == 1);                 // doc 2 is the weakest in round 0, doc 1 in round 1
  CHECK(r.strongestDoc[0] == 0);
  ReadinessReport empty;
  CHECK(computeDocReadiness(2, 2, {0, 3}, {}, empty) && empty.weakestDoc[0] == -1 && empty.percent[0] == 0.0);   // empty round: no division by zero
  CHECK(!computeDocReadiness(2, 2, {1}, {}, empty));                   // wrong number of round totals
  CHECK(!computeDocReadiness(2, 2, {1, 1}, {{5, 0, 1}}, empty));       // document out of range
}

// ================================ PROTOCOL ================================
TEST(toolkit_protocol_runs_all_phase5_commands_and_still_serves_the_queue) {
  Toolkit tk(3);
  bool quit = false;
  auto run = [&](const std::string& l) { return handleToolkitLine(tk, l, quit); };
  auto has = [](const std::string& s, const char* t) { return s.find(t) != std::string::npos; };

  CHECK(has(run("SEARCH_APP MH"), "NOT_BUILT"));                       // cannot search before the index is built
  CHECK(has(run("INDEX_ADD 2 1:MH2026-1:Asha~Rao 2:MH2026-2:Bina~Rao"), "\"added\":2"));
  CHECK(has(run("INDEX_ADD 3 1:x:y"), "BAD_ARGUMENT"));                // count mismatch
  CHECK(has(run("INDEX_TOKENS 1 4:R:2"), "\"added\":1"));
  CHECK(has(run("INDEX_BUILD"), "\"algorithm\":\"merge sort\""));
  CHECK(has(run("SEARCH_APP mh2026-2"), "\"matches\":[2]"));
  CHECK(has(run("SEARCH_TOKEN r004"), "\"matches\":[2]"));
  CHECK(has(run("SEARCH_NAME rao"), "\"matches\":[1,2]"));
  CHECK(has(run("SEARCH_NAME asha~r"), "\"matches\":[1]"));
  CHECK(has(run("SORT unscheduled 2 1:3:0:0:9:b 2:1:0:0:9:a"), "\"order\":[2,1]"));
  CHECK(has(run("SORT shell 0"), "BAD_ARGUMENT"));
  CHECK(has(run("STACK_POP 1"), "EMPTY"));
  run("STACK_PUSH 1 7 70 review"); run("STACK_PUSH 1 8 80 reschedule");
  CHECK(has(run("STACK_PEEK 1"), "\"actionId\":8"));
  CHECK(has(run("STACK_LIST 1"), "\"size\":2"));
  CHECK(has(run("STACK_POP 1"), "\"actionId\":8"));
  CHECK(has(run("STACK_POP 1"), "\"actionId\":7"));
  CHECK(has(run("STACK_POP 1"), "EMPTY"));
  CHECK(has(run("APPT_LOAD 2 48 18 34 2 0:20 0:20"), "\"cells\":[[0,20,2]]"));
  CHECK(has(run("DOC_READINESS 1 1 2 1 0:0:2"), "\"percent\":[100.0]"));
  CHECK(has(run("STACK_PUSH x"), "BAD_ARGUMENT"));
  // the Phase 4 queue still answers through the same entry point
  run("COUNTER 1 1");
  CHECK(has(run("ENQUEUE 1 5 MH2026-9"), "\"code\":\"P001\""));
  CHECK(has(run("CALL 1"), "\"status\":\"called\""));
  CHECK(has(run("NOPE"), "BAD_COMMAND"));
  CHECK(!quit);
  run("QUIT"); CHECK(quit);
}

// ================================ ADMISSION PROGRESS QUEUE (MAX-HEAP) ================================
TEST(admission_progress_heap_max_priority_and_fifo_tie_breaking) {
  AdmissionProgressHeap h;
  CHECK(h.empty() && h.size() == 0);
  CHECK(h.peek() == nullptr);

  // Student 1: score 0.5000, entered 10:00
  h.upsert(1, "AF-001", 0.5000, "2026-08-15 10:00:00");
  // Student 2: score 0.8500, entered 11:00 (higher score)
  h.upsert(2, "AF-002", 0.8500, "2026-08-15 11:00:00");
  // Student 3: score 0.5000, entered 09:30 (same score as #1, but earlier entry -> FIFO winner)
  h.upsert(3, "AF-003", 0.5000, "2026-08-15 09:30:00");
  // Student 4: score 0.5000, entered 10:00 (same score, same timestamp as #1 -> smaller ID winner)
  h.upsert(4, "AF-004", 0.5000, "2026-08-15 10:00:00");

  CHECK(h.size() == 4);
  CHECK(h.peek() != nullptr && h.peek()->studentId == 2);

  auto ranked = h.getRanked();
  CHECK(ranked.size() == 4);
  CHECK(ranked[0].studentId == 2);   // 0.8500
  CHECK(ranked[1].studentId == 3);   // 0.5000, 09:30
  CHECK(ranked[2].studentId == 1);   // 0.5000, 10:00, id 1
  CHECK(ranked[3].studentId == 4);   // 0.5000, 10:00, id 4
}

TEST(admission_progress_heap_priority_updates_and_completion_removal) {
  AdmissionProgressHeap h;
  h.upsert(1, "AF-001", 0.4000, "2026-08-15 10:00:00");
  h.upsert(2, "AF-002", 0.6000, "2026-08-15 10:00:00");
  h.upsert(3, "AF-003", 0.8000, "2026-08-15 10:00:00");

  CHECK(h.peek()->studentId == 3);

  // Update student 1's score to 0.9500 (e.g. deadline closer or tasks approved) -> moves to position 1
  h.upsert(1, "AF-001", 0.9500, "2026-08-15 10:00:00");
  CHECK(h.peek()->studentId == 1);
  auto r1 = h.getRanked();
  CHECK(r1.size() == 3 && r1[0].studentId == 1 && r1[1].studentId == 3 && r1[2].studentId == 2);

  // Remove student 1 upon 6/6 tasks approved
  CHECK(h.remove(1));
  CHECK(!h.contains(1));
  CHECK(h.size() == 2);
  CHECK(h.peek()->studentId == 3);
  auto r2 = h.getRanked();
  CHECK(r2.size() == 2 && r2[0].studentId == 3 && r2[1].studentId == 2);

  // Removing non-existent or already removed returns false
  CHECK(!h.remove(1));
  CHECK(!h.remove(999));

  // Re-inserting student 1 (e.g. if task corrected and status reverted to active)
  h.upsert(1, "AF-001", 0.3000, "2026-08-15 10:00:00");
  CHECK(h.size() == 3);
  auto r3 = h.getRanked();
  CHECK(r3.size() == 3 && r3[0].studentId == 3 && r3[1].studentId == 2 && r3[2].studentId == 1);
}

TEST(admission_progress_heap_regression_rohan_joshi_vs_sneha_patil) {
  // Regression test: Rohan Joshi (score 0.5191) MUST rank before Sneha Patil (score 0.4524)
  // regardless of insertion order, student IDs (Sneha ID 3 vs Rohan ID 4), or timestamps.
  AdmissionProgressHeap h;
  // Insert Sneha first with lower score 0.4524, earlier timestamp, smaller student ID (3)
  h.upsert(3, "AF-003", 0.4524, "2026-08-15 08:00:00");
  // Insert Rohan second with higher score 0.5191, later timestamp, larger student ID (4)
  h.upsert(4, "AF-004", 0.5191, "2026-08-15 09:00:00");

  CHECK(h.peek() != nullptr);
  CHECK(h.peek()->studentId == 4); // Rohan Joshi must be at top

  auto ranked = h.getRanked();
  CHECK(ranked.size() == 2);
  CHECK(ranked[0].studentId == 4); // Position 1: Rohan Joshi
  CHECK(std::abs(ranked[0].score - 0.5191) < 1e-4);

  CHECK(ranked[1].studentId == 3); // Position 2: Sneha Patil
  CHECK(std::abs(ranked[1].score - 0.4524) < 1e-4);
}

TEST(toolkit_protocol_progress_commands) {
  Toolkit tk(3);
  bool quit = false;
  auto run = [&](const std::string& l) { return handleToolkitLine(tk, l, quit); };
  auto has = [](const std::string& s, const char* t) { return s.find(t) != std::string::npos; };

  CHECK(has(run("PROGRESS_CLEAR"), "\"ok\":true"));
  CHECK(has(run("PROGRESS_SIZE"), "\"size\":0"));
  CHECK(has(run("PROGRESS_PEEK"), "\"hasStudent\":false"));

  // Batch load
  CHECK(has(run("PROGRESS_LOAD 3 10|AF-010|0.5000|2026-08-15~10:00:00 20|AF-020|0.7500|2026-08-15~09:00:00 30|AF-030|0.7500|2026-08-15~08:30:00"), "\"loaded\":3"));
  CHECK(has(run("PROGRESS_SIZE"), "\"size\":3"));

  // PROGRESS_RANK must have: student 30 (pos 1, earlier time), student 20 (pos 2), student 10 (pos 3)
  std::string rankRep = run("PROGRESS_RANK");
  CHECK(has(rankRep, "\"ok\":true"));
  CHECK(has(rankRep, "\"position\":1,\"studentId\":30"));
  CHECK(has(rankRep, "\"position\":2,\"studentId\":20"));
  CHECK(has(rankRep, "\"position\":3,\"studentId\":10"));

  // Upsert student 10 with top score 0.9500
  CHECK(has(run("PROGRESS_UPSERT 10 AF-010 0.9500 2026-08-15~10:00:00"), "\"studentId\":10"));
  CHECK(has(run("PROGRESS_PEEK"), "\"studentId\":10"));

  // Remove student 10
  CHECK(has(run("PROGRESS_REMOVE 10"), "\"removed\":true"));
  CHECK(has(run("PROGRESS_SIZE"), "\"size\":2"));
  CHECK(has(run("PROGRESS_PEEK"), "\"studentId\":30"));

  // Clear
  CHECK(has(run("PROGRESS_CLEAR"), "\"ok\":true"));
  CHECK(has(run("PROGRESS_SIZE"), "\"size\":0"));
}

int main() {
  for (auto& t : registry()) {
    int before = g_failed;
    t.second();
    std::printf("%s %s\n", g_failed == before ? "PASS" : "FAIL", t.first.c_str());
  }
  std::printf("\n%d tests, %d checks, %d failed\n", static_cast<int>(registry().size()), g_checks, g_failed);
  return g_failed == 0 ? 0 : 1;
}
