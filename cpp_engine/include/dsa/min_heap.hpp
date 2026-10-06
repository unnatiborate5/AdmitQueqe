// MinHeap - an array-based binary heap used as a PRIORITY QUEUE.
//
// WHERE IT IS USED: the PRIORITY waiting lane. Entries are ordered by (priority level, arrival number),
// so the most urgent student is always at the top.
// WHY A HEAP: the next student to call must be found among all priority students by two keys, and
// students keep arriving. A heap gives push and pop in O(log n) and peek in O(1); keeping a sorted list
// would cost O(n) per arrival. Equal-priority students are ordered by arrival number, which is what
// makes the lane fair (first come, first served within a priority level).
//
// The heap has no cheap "delete from the middle", so the engine uses LAZY DELETION: a cancelled
// student's entry stays in the heap and is skipped when it reaches the top.
#ifndef ADMITFLOW_MIN_HEAP_HPP
#define ADMITFLOW_MIN_HEAP_HPP

#include <cstddef>
#include <utility>
#include <vector>

namespace admitflow {

// `Less(a, b)` is true when a must come out BEFORE b.
template <typename T, typename Less>
class MinHeap {
 public:
  explicit MinHeap(Less less = Less()) : less_(less) {}

  void push(const T& value) {
    a_.push_back(value);
    siftUp(a_.size() - 1);
  }

  const T* top() const { return a_.empty() ? nullptr : &a_.front(); }

  bool pop(T& out) {
    if (a_.empty()) return false;
    out = a_.front();
    a_.front() = a_.back();
    a_.pop_back();
    if (!a_.empty()) siftDown(0);
    return true;
  }

  bool empty() const { return a_.empty(); }
  std::size_t size() const { return a_.size(); }
  void clear() { a_.clear(); }

 private:
  void siftUp(std::size_t i) {
    while (i > 0) {
      std::size_t parent = (i - 1) / 2;
      if (!less_(a_[i], a_[parent])) break;
      std::swap(a_[i], a_[parent]);
      i = parent;
    }
  }

  void siftDown(std::size_t i) {
    const std::size_t n = a_.size();
    for (;;) {
      std::size_t l = 2 * i + 1, r = l + 1, best = i;
      if (l < n && less_(a_[l], a_[best])) best = l;
      if (r < n && less_(a_[r], a_[best])) best = r;
      if (best == i) return;
      std::swap(a_[i], a_[best]);
      i = best;
    }
  }

  std::vector<T> a_;
  Less less_;
};

}  // namespace admitflow

#endif
