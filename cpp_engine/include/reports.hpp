// Matrix reports.
//
//   computeAppointmentLoad  SPARSE matrix (days x 30-minute slots): how crowded is each slot, which slots are the busiest,
//                           and which slot of each day is the least loaded inside office hours (for "suggest a slot").
//   computeDocReadiness     DENSE matrix (documents x CAP rounds): how many students of each round have each document
//                           ready, as counts and percentages, and the weakest document of each round.
#ifndef ADMITFLOW_REPORTS_HPP
#define ADMITFLOW_REPORTS_HPP

#include <utility>
#include <vector>

namespace admitflow {

struct LoadCell { int row; int col; int count; };
struct BestSlot { int col; int count; };   // col = -1 when the day has no slot in the searched range

struct LoadReport {
  int rows = 0, cols = 0;
  std::size_t nonZeros = 0;
  double density = 0;
  std::vector<LoadCell> cells;        // non-zero cells only, row-major
  std::vector<int> rowSums;           // bookings per day
  std::vector<int> colSums;           // bookings per slot, summed over all days
  std::vector<LoadCell> busiest;      // top cells, most booked first (merge sort), ties earliest first
  std::vector<BestSlot> bestSlots;    // per day: least-loaded slot in [fromCol, toCol), earliest wins ties
  std::size_t lookupComparisons = 0;  // binary-search steps spent finding cells
};

// `bookings` = one (day, slot) pair per appointment. Pairs outside the grid are rejected by returning false.
bool computeAppointmentLoad(int rows, int cols, int fromCol, int toCol, const std::vector<std::pair<int, int>>& bookings, LoadReport& out);

struct ReadinessReport {
  int docs = 0, rounds = 0;
  std::vector<int> counts;            // docs x rounds, row-major
  std::vector<double> percent;        // counts / roundTotals * 100 (0 when the round has no students)
  std::vector<int> docTotals;         // row sums: how many (student, round) preparations per document
  std::vector<int> roundTotals;       // students in each round (given)
  std::vector<int> weakestDoc;        // per round: document with the fewest students ready (-1 if the round is empty)
  std::vector<int> strongestDoc;
};

struct DocCount { int doc; int round; int count; };
bool computeDocReadiness(int docs, int rounds, const std::vector<int>& roundTotals, const std::vector<DocCount>& cells, ReadinessReport& out);

}  // namespace admitflow

#endif
