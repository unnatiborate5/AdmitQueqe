#include "reports.hpp"

#include "algo/merge_sort.hpp"
#include "dsa/dense_matrix.hpp"
#include "dsa/sparse_matrix.hpp"

namespace admitflow {

bool computeAppointmentLoad(int rows, int cols, int fromCol, int toCol, const std::vector<std::pair<int, int>>& bookings, LoadReport& out) {
  if (rows < 1 || cols < 1 || fromCol < 0 || toCol > cols || fromCol >= toCol) return false;
  SparseMatrix<int> m(rows, cols);
  for (const auto& b : bookings) {
    if (b.first < 0 || b.first >= rows || b.second < 0 || b.second >= cols) return false;
    m.add(b.first, b.second, 1);   // many appointments in one slot accumulate in one cell
  }
  out = LoadReport();
  out.rows = rows;
  out.cols = cols;
  out.nonZeros = m.nonZeros();
  out.density = m.density();
  for (const auto& e : m.entries()) out.cells.push_back(LoadCell{e.row, e.col, e.value});
  out.rowSums = m.rowSums();
  out.colSums = m.colSums();

  out.busiest = out.cells;
  mergeSort(out.busiest, [](const LoadCell& a, const LoadCell& b) { return a.count > b.count; });   // stable: ties keep time order
  if (out.busiest.size() > 5) out.busiest.resize(5);

  for (int r = 0; r < rows; ++r) {
    BestSlot best{-1, 0};
    for (int c = fromCol; c < toCol; ++c) {
      const int n = m.get(r, c);              // binary search in the sparse entries
      if (best.col < 0 || n < best.count) best = BestSlot{c, n};
    }
    out.bestSlots.push_back(best);
  }
  out.lookupComparisons = m.lookupComparisons();
  return true;
}

bool computeDocReadiness(int docs, int rounds, const std::vector<int>& roundTotals, const std::vector<DocCount>& cells, ReadinessReport& out) {
  if (docs < 1 || rounds < 1 || static_cast<int>(roundTotals.size()) != rounds) return false;
  DenseMatrix<int> m(static_cast<std::size_t>(docs), static_cast<std::size_t>(rounds));
  for (const DocCount& c : cells) {
    if (c.doc < 0 || c.doc >= docs || c.round < 0 || c.round >= rounds || c.count < 0) return false;
    m.at(static_cast<std::size_t>(c.doc), static_cast<std::size_t>(c.round)) += c.count;
  }
  out = ReadinessReport();
  out.docs = docs;
  out.rounds = rounds;
  out.roundTotals = roundTotals;
  for (int d = 0; d < docs; ++d) {
    out.docTotals.push_back(m.rowSum(static_cast<std::size_t>(d)));
    for (int r = 0; r < rounds; ++r) {
      const int n = m.at(static_cast<std::size_t>(d), static_cast<std::size_t>(r));
      out.counts.push_back(n);
      out.percent.push_back(roundTotals[static_cast<std::size_t>(r)] > 0 ? 100.0 * n / roundTotals[static_cast<std::size_t>(r)] : 0.0);
    }
  }
  for (int r = 0; r < rounds; ++r) {
    const bool empty = roundTotals[static_cast<std::size_t>(r)] == 0;
    out.weakestDoc.push_back(empty ? -1 : static_cast<int>(m.argMinInColumn(static_cast<std::size_t>(r))));
    out.strongestDoc.push_back(empty ? -1 : static_cast<int>(m.argMaxInColumn(static_cast<std::size_t>(r))));
  }
  return true;
}

}  // namespace admitflow
