// Matrix reports: SparseMatrix for appointment load, DenseMatrix for document readiness.
#ifndef ADMITFLOW_REPORTS_H
#define ADMITFLOW_REPORTS_H

#include <utility>
#include <vector>

namespace admitflow {

struct LoadCell { int row; int col; int count; };
struct BestSlot { int col; int count; };

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

bool computeAppointmentLoad(int rows, int cols, int fromCol, int toCol,
                            const std::vector<std::pair<int, int>>& bookings,
                            LoadReport& out);

struct ReadinessReport {
  int docs = 0, rounds = 0;
  std::vector<int> counts;            // docs x rounds, row-major
  std::vector<double> percent;        // counts / roundTotals * 100
  std::vector<int> docTotals;         // row sums
  std::vector<int> roundTotals;       // students in each round
  std::vector<int> weakestDoc;        // per round: fewest students ready (-1 if empty)
  std::vector<int> strongestDoc;
};

struct DocCount { int doc; int round; int count; };
bool computeDocReadiness(int docs, int rounds,
                         const std::vector<int>& roundTotals,
                         const std::vector<DocCount>& cells,
                         ReadinessReport& out);

}  // namespace admitflow

#endif

