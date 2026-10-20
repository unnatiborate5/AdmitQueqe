// mergeSort - stable top-down merge sort, O(n log n) in every case.
//
// WHERE IT IS USED
//   * SearchIndex::build   sorts students by application ID and tokens by number, so BINARY SEARCH is possible.
//   * planner (sortWork)   ranks the admin worklists (who to schedule first, who arrives when) by several keys.
//   * reports              ranks the busiest appointment slots.
// WHY MERGE SORT
//   The worklists are sorted by several keys (priority, then time, then name). It must be STABLE: students that
//   tie on every key keep the order they were supplied in, so results never shuffle between two page loads.
//   Merge sort is stable and has no bad case; quick sort is not stable and degrades on sorted input, which is
//   exactly what a day's already-ordered tokens look like.
// Returns the number of comparisons made (reported to the admin UI and checked in tests).
#ifndef ADMITFLOW_MERGE_SORT_HPP
#define ADMITFLOW_MERGE_SORT_HPP

#include <cstddef>
#include <vector>

namespace admitflow {

namespace detail {
template <typename T, typename Less>
void mergeSortRange(std::vector<T>& a, std::vector<T>& tmp, std::size_t lo, std::size_t hi, Less& less, std::size_t& cmp) {
  if (hi - lo < 2) return;
  const std::size_t mid = lo + (hi - lo) / 2;
  mergeSortRange(a, tmp, lo, mid, less, cmp);
  mergeSortRange(a, tmp, mid, hi, less, cmp);
  std::size_t i = lo, j = mid, k = lo;
  while (i < mid && j < hi) {
    ++cmp;
    if (less(a[j], a[i])) tmp[k++] = a[j++];   // take from the right only when STRICTLY smaller: keeps ties in input order
    else tmp[k++] = a[i++];
  }
  while (i < mid) tmp[k++] = a[i++];
  while (j < hi) tmp[k++] = a[j++];
  for (k = lo; k < hi; ++k) a[k] = tmp[k];
}
}  // namespace detail

template <typename T, typename Less>
std::size_t mergeSort(std::vector<T>& a, Less less) {
  std::size_t comparisons = 0;
  if (a.size() < 2) return 0;
  std::vector<T> tmp(a.size());
  detail::mergeSortRange(a, tmp, 0, a.size(), less, comparisons);
  return comparisons;
}

}  // namespace admitflow

#endif
