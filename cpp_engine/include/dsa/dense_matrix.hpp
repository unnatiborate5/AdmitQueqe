// DenseMatrix - a rows x cols grid stored as one contiguous row-major array.
//
// WHERE IT IS USED: the document-readiness report (reports.hpp). Rows = the 9 documents students prepare,
// columns = the 4 CAP rounds, each cell = how many students of that round have prepared that document.
// WHY DENSE: the grid is tiny and fixed (9 x 4) and EVERY cell is a real, meaningful number (a zero is information:
// "nobody has this document yet"). A dense array gives O(1) access by index, and row/column sums and
// minimum-per-column scans are plain loops over contiguous memory. Sparse storage would only add overhead here.
#ifndef ADMITFLOW_DENSE_MATRIX_HPP
#define ADMITFLOW_DENSE_MATRIX_HPP

#include <cstddef>
#include <stdexcept>
#include <vector>

namespace admitflow {

template <typename T>
class DenseMatrix {
 public:
  DenseMatrix(std::size_t rows, std::size_t cols) : rows_(rows), cols_(cols), data_(rows * cols, T()) {}

  std::size_t rows() const { return rows_; }
  std::size_t cols() const { return cols_; }

  T& at(std::size_t r, std::size_t c) { check(r, c); return data_[r * cols_ + c]; }
  const T& at(std::size_t r, std::size_t c) const { check(r, c); return data_[r * cols_ + c]; }

  T rowSum(std::size_t r) const { T s = T(); for (std::size_t c = 0; c < cols_; ++c) s += at(r, c); return s; }
  T colSum(std::size_t c) const { T s = T(); for (std::size_t r = 0; r < rows_; ++r) s += at(r, c); return s; }

  // Row index holding the smallest value in column c (first one wins ties). rows() must be > 0.
  std::size_t argMinInColumn(std::size_t c) const {
    std::size_t best = 0;
    for (std::size_t r = 1; r < rows_; ++r) if (at(r, c) < at(best, c)) best = r;
    return best;
  }
  std::size_t argMaxInColumn(std::size_t c) const {
    std::size_t best = 0;
    for (std::size_t r = 1; r < rows_; ++r) if (at(best, c) < at(r, c)) best = r;
    return best;
  }

 private:
  void check(std::size_t r, std::size_t c) const { if (r >= rows_ || c >= cols_) throw std::out_of_range("DenseMatrix index"); }

  std::size_t rows_, cols_;
  std::vector<T> data_;
};

}  // namespace admitflow

#endif
