// FifoQueue - a first-in-first-out queue built on a singly linked list.
//
// WHERE IT IS USED: the REGULAR waiting lane of the verification queue (students with no priority).
// WHY A QUEUE: regular students must be served strictly in the order they checked in. enqueue and
// dequeue are O(1) (head/tail pointers), so the lane stays fast however many students are waiting.
//
// Two extra operations exist because real queues change:
//   removeIf()    - a waiting student cancels / becomes ineligible: remove them from the middle (O(n)).
//   insertSorted()- a CALLED student is sent back (counter closed): re-insert at their ORIGINAL position
//                   (by arrival number) instead of the back, so nobody loses their place.
#ifndef ADMITFLOW_FIFO_QUEUE_HPP
#define ADMITFLOW_FIFO_QUEUE_HPP

#include <cstddef>

namespace admitflow {

template <typename T>
class FifoQueue {
 public:
  FifoQueue() = default;
  ~FifoQueue() { clear(); }
  FifoQueue(const FifoQueue&) = delete;
  FifoQueue& operator=(const FifoQueue&) = delete;

  void push(const T& value) {
    Node* n = new Node{value, nullptr};
    if (tail_ == nullptr) head_ = tail_ = n;
    else { tail_->next = n; tail_ = n; }
    ++size_;
  }

  // Removes the oldest element into `out`. Returns false when empty.
  bool pop(T& out) {
    if (head_ == nullptr) return false;
    Node* n = head_;
    out = n->value;
    head_ = n->next;
    if (head_ == nullptr) tail_ = nullptr;
    delete n;
    --size_;
    return true;
  }

  const T* front() const { return head_ ? &head_->value : nullptr; }
  bool empty() const { return size_ == 0; }
  std::size_t size() const { return size_; }

  // Inserts `value` before the first element x for which less(value, x) is true (else at the back).
  template <typename Less>
  void insertSorted(const T& value, Less less) {
    Node* n = new Node{value, nullptr};
    if (head_ == nullptr) { head_ = tail_ = n; ++size_; return; }
    if (less(value, head_->value)) { n->next = head_; head_ = n; ++size_; return; }
    Node* cur = head_;
    while (cur->next != nullptr && !less(value, cur->next->value)) cur = cur->next;
    n->next = cur->next;
    cur->next = n;
    if (n->next == nullptr) tail_ = n;
    ++size_;
  }

  // Removes every element for which pred(element) is true. Returns how many were removed.
  template <typename Pred>
  std::size_t removeIf(Pred pred) {
    std::size_t removed = 0;
    Node* prev = nullptr;
    Node* cur = head_;
    while (cur != nullptr) {
      Node* next = cur->next;
      if (pred(cur->value)) {
        if (prev == nullptr) head_ = next; else prev->next = next;
        if (cur == tail_) tail_ = prev;
        delete cur;
        --size_;
        ++removed;
      } else {
        prev = cur;
      }
      cur = next;
    }
    return removed;
  }

  // Visits elements from oldest to newest.
  template <typename F>
  void forEach(F f) const {
    for (Node* n = head_; n != nullptr; n = n->next) f(n->value);
  }

  void clear() {
    while (head_ != nullptr) { Node* n = head_; head_ = n->next; delete n; }
    tail_ = nullptr;
    size_ = 0;
  }

 private:
  struct Node { T value; Node* next; };
  Node* head_ = nullptr;
  Node* tail_ = nullptr;
  std::size_t size_ = 0;
};

}  // namespace admitflow

#endif
