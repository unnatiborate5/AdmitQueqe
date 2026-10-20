// UndoStacks - one bounded Stack of recent reversible actions per admin, found through a HashMap.
//
// An "action" is only an identifier here (the details live in the database): which admin, which action row, which
// student, what kind. The Node backend decides HOW to reverse it; this class decides WHICH one is next (the newest).
//   HashMap: admin id -> that admin's Stack.   An admin can only ever undo their own actions.
//   Stack  : newest action on top; push on every reversible change, pop on undo, peek to show "Undo: ...".
#ifndef ADMITFLOW_UNDO_STACKS_HPP
#define ADMITFLOW_UNDO_STACKS_HPP

#include <string>
#include <vector>

#include "dsa/hash_map.hpp"
#include "dsa/stack.hpp"

namespace admitflow {

struct UndoEntry {
  long long actionId = 0;
  long long studentId = 0;
  std::string kind;
};

class UndoStacks {
 public:
  explicit UndoStacks(std::size_t capacityPerAdmin = 20) : capacity_(capacityPerAdmin) {}

  // Returns true when the admin's oldest entry was discarded (copied to *dropped).
  bool push(long long adminId, const UndoEntry& e, UndoEntry* dropped) {
    Stack<UndoEntry>* s = stacks_.find(adminId);
    if (s == nullptr) s = stacks_.put(adminId, Stack<UndoEntry>(capacity_));
    return s->push(e, dropped);
  }
  bool pop(long long adminId, UndoEntry& out) {
    Stack<UndoEntry>* s = stacks_.find(adminId);
    return s != nullptr && s->pop(out);
  }
  const UndoEntry* peek(long long adminId) const {
    const Stack<UndoEntry>* s = stacks_.find(adminId);
    return s == nullptr ? nullptr : s->peek();
  }
  std::vector<UndoEntry> list(long long adminId) const {   // newest first
    std::vector<UndoEntry> out;
    const Stack<UndoEntry>* s = stacks_.find(adminId);
    if (s != nullptr) s->forEachTopDown([&](const UndoEntry& e) { out.push_back(e); });
    return out;
  }
  std::size_t size(long long adminId) const { const Stack<UndoEntry>* s = stacks_.find(adminId); return s == nullptr ? 0 : s->size(); }
  void clearAll() { stacks_.clear(); }
  std::size_t capacity() const { return capacity_; }

 private:
  std::size_t capacity_;
  HashMap<long long, Stack<UndoEntry>, IntHash> stacks_;
};

}  // namespace admitflow

#endif
