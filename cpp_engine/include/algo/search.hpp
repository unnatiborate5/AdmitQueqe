// Searching algorithms.
//
//   lowerBound / upperBound   BINARY SEARCH on a sorted vector, O(log n).
//   linearSearchAll           LINEAR SEARCH, O(n).
//
// WHERE THEY ARE USED
//   Binary search : SearchIndex (application-ID prefix lookup, token-number lookup) and SparseMatrix (find a cell).
//                   Both structures are kept sorted, so every lookup halves the range instead of scanning it.
//   Linear search : SearchIndex::findByName. A name fragment ("kul" inside "Meera Kulkarni") has no sort order that
//                   binary search could use, so every record has to be examined; the scan count is reported.
// Every function counts its comparisons so the admin UI can show the work done and tests can prove O(log n).
#ifndef ADMITFLOW_SEARCH_HPP
#define ADMITFLOW_SEARCH_HPP

#include <cstddef>
#include <vector>

namespace admitflow {

// First index i such that !elemLess(a[i], key), i.e. the first element that is >= key. n if none.
template <typename T, typename Key, typename ElemLess>
std::size_t lowerBound(const std::vector<T>& a, const Key& key, ElemLess elemLess, std::size_t& comparisons) {
  std::size_t lo = 0, hi = a.size();
  while (lo < hi) {
    const std::size_t mid = lo + (hi - lo) / 2;
    ++comparisons;
    if (elemLess(a[mid], key)) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// First index i such that keyLess(key, a[i]), i.e. the first element that is > key. n if none.
template <typename T, typename Key, typename KeyLess>
std::size_t upperBound(const std::vector<T>& a, const Key& key, KeyLess keyLess, std::size_t& comparisons) {
  std::size_t lo = 0, hi = a.size();
  while (lo < hi) {
    const std::size_t mid = lo + (hi - lo) / 2;
    ++comparisons;
    if (keyLess(key, a[mid])) hi = mid; else lo = mid + 1;
  }
  return lo;
}

// Indices of every element for which pred(element) is true, scanning from the front.
template <typename T, typename Pred>
std::vector<std::size_t> linearSearchAll(const std::vector<T>& a, Pred pred, std::size_t& comparisons) {
  std::vector<std::size_t> hits;
  for (std::size_t i = 0; i < a.size(); ++i) {
    ++comparisons;
    if (pred(a[i])) hits.push_back(i);
  }
  return hits;
}

}  // namespace admitflow

#endif
