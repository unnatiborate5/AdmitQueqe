// SparseMatrix - triplet (coordinate) representation: only NON-ZERO cells are stored, as (row, col, value)
// entries kept sorted in row-major order.
//
// WHERE IT IS USED: the appointment-load report (reports.hpp). Rows = days, columns = 30-minute slots of the day,
// each cell = number of students booked in that slot. A 31-day x 48-slot grid has 1,488 cells, but a college books
// only a few dozen appointments, so well over 90% of the cells are zero.
// WHY SPARSE: storing all 1,488 cells to remember ~40 numbers wastes memory and makes every report scan mostly
// zeros. The triplet list stores exactly the booked slots. Because it is sorted, a cell is found by BINARY SEARCH
// (O(log k) for k stored cells) and row/column totals are single passes over the k entries.
// A cell that returns to 0 is removed, so the matrix never stores zeros.
#ifndef ADMITFLOW_SPARSE_MATRIX_HPP
#define ADMITFLOW_SPARSE_MATRIX_HPP

#include <cstddef>
#include <stdexcept>
#include <vector>

#include "../algo/search.hpp"

namespace admitflow {

template <typename T>
class SparseMatrix {
 public:
  struct Entry { int row; int col; T value; };

  SparseMatrix(int rows, int cols) : rows_(rows), cols_(cols) {}

  int rows() const { return rows_; }
  int cols() const { return cols_; }
  std::size_t nonZeros() const { return entries_.size(); }
  std::size_t lookupComparisons() const { return comparisons_; }   // binary-search steps spent so far

  // Adds `delta` to a cell (creating it if absent, removing it if it becomes 0).
  void add(int r, int c, T delta) {
    check(r, c);
    const std::size_t pos = find(r, c);
    if (pos < entries_.size() && entries_[pos].row == r && entries_[pos].col == c) {
      entries_[pos].value += delta;
      if (entries_[pos].value == T()) entries_.erase(entries_.begin() + static_cast<std::ptrdiff_t>(pos));
    } else if (delta != T()) {
      entries_.insert(entries_.begin() + static_cast<std::ptrdiff_t>(pos), Entry{r, c, delta});
    }
  }

  T get(int r, int c) const {
    check(r, c);
    const std::size_t pos = find(r, c);
    return (pos < entries_.size() && entries_[pos].row == r && entries_[pos].col == c) ? entries_[pos].value : T();
  }

  std::vector<T> rowSums() const { std::vector<T> s(static_cast<std::size_t>(rows_), T()); for (const Entry& e : entries_) s[static_cast<std::size_t>(e.row)] += e.value; return s; }
  std::vector<T> colSums() const { std::vector<T> s(static_cast<std::size_t>(cols_), T()); for (const Entry& e : entries_) s[static_cast<std::size_t>(e.col)] += e.value; return s; }
  const std::vector<Entry>& entries() const { return entries_; }   // sorted by (row, col)
  double density() const { return rows_ > 0 && cols_ > 0 ? static_cast<double>(entries_.size()) / (static_cast<double>(rows_) * cols_) : 0.0; }

 private:
  void check(int r, int c) const { if (r < 0 || r >= rows_ || c < 0 || c >= cols_) throw std::out_of_range("SparseMatrix index"); }

  // Binary search for the first stored entry at or after (r, c).
  std::size_t find(int r, int c) const {
    struct Key { int r, c; } key{r, c};
    return lowerBound(entries_, key, [](const Entry& e, const Key& k) { return e.row != k.r ? e.row < k.r : e.col < k.c; }, comparisons_);
  }

  int rows_, cols_;
  std::vector<Entry> entries_;
  mutable std::size_t comparisons_ = 0;
};

}  // namespace admitflow

#endif
