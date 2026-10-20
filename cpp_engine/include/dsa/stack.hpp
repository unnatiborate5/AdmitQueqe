// Stack - last-in-first-out, array based, optionally bounded.
//
// WHERE IT IS USED: UndoStacks (undo_stacks.hpp): one stack per admin holding their recent REVERSIBLE actions
// (application decisions, appointment reschedules).
// WHY A STACK: undo must reverse the newest action first. If an admin approves, then reschedules, then undoes
// twice, the reschedule must come back before the approval. That is LIFO; any other order would revert an older
// change on top of a newer one. push / pop / peek are all O(1).
// BOUNDED: with a capacity, pushing onto a full stack discards the OLDEST entry (the bottom), so the undo list stays
// short and recent. The discarded entry is reported to the caller.
#ifndef ADMITFLOW_STACK_HPP
#define ADMITFLOW_STACK_HPP

#include <cstddef>
#include <vector>

namespace admitflow {

template <typename T>
class Stack {
 public:
  explicit Stack(std::size_t capacity = 0) : capacity_(capacity) {}   // 0 = unbounded

  // Returns true (and fills *dropped) when the oldest entry had to be discarded to make room.
  bool push(const T& value, T* dropped = nullptr) {
    bool discarded = false;
    if (capacity_ > 0 && items_.size() >= capacity_) {
      if (dropped != nullptr) *dropped = items_.front();
      items_.erase(items_.begin());
      discarded = true;
    }
    items_.push_back(value);
    return discarded;
  }

  bool pop(T& out) {
    if (items_.empty()) return false;
    out = items_.back();
    items_.pop_back();
    return true;
  }

  const T* peek() const { return items_.empty() ? nullptr : &items_.back(); }
  bool empty() const { return items_.empty(); }
  std::size_t size() const { return items_.size(); }
  std::size_t capacity() const { return capacity_; }
  void clear() { items_.clear(); }

  // Visits entries from the top (newest) down to the bottom (oldest).
  template <typename F>
  void forEachTopDown(F f) const {
    for (std::size_t i = items_.size(); i > 0; --i) f(items_[i - 1]);
  }

 private:
  std::vector<T> items_;
  std::size_t capacity_;
};

}  // namespace admitflow

#endif
