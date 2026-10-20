#ifndef ADMITFLOW_ADMISSION_PROGRESS_HEAP_HPP
#define ADMITFLOW_ADMISSION_PROGRESS_HEAP_HPP

#include <cmath>
#include <cstddef>
#include <string>
#include <vector>

#include "dsa/hash_map.hpp"
#include "dsa/min_heap.hpp"

namespace admitflow {

// Represents an entry inside the MinHeap.
struct ProgressHeapEntry {
  long long studentId = 0;
  std::string token;
  double score = 0.0;
  std::string enteredAt;
  long long version = 0;
};

// Max-priority comparator for MinHeap:
// Returns true when 'a' should come out BEFORE 'b'.
// 1. Higher score first (difference > 1e-7).
// 2. Tie-break: earlier entered_at time (FIFO: lexicographical comparison of ISO timestamps).
// 3. Fallback: smaller studentId.
struct ProgressScoreGreater {
  bool operator()(const ProgressHeapEntry& a, const ProgressHeapEntry& b) const {
    const double diff = a.score - b.score;
    if (diff > 1e-7) return true;
    if (diff < -1e-7) return false;

    // Equal score: earlier queue entry time (FIFO)
    if (a.enteredAt != b.enteredAt) {
      return a.enteredAt < b.enteredAt;
    }

    // Tertiary: deterministic fallback by studentId
    return a.studentId < b.studentId;
  }
};

// Represents the canonical stored student in the progress heap's map.
struct ProgressStudent {
  long long studentId = 0;
  std::string token;
  double score = 0.0;
  std::string enteredAt;
  long long version = 0;
  bool active = true;
};

class AdmissionProgressHeap {
 public:
  AdmissionProgressHeap() : heap_(ProgressScoreGreater()), map_(64), activeCount_(0) {}

  // Inserts a new student or updates existing student's priority score.
  // Returns true on success.
  bool upsert(long long studentId, const std::string& token, double score, const std::string& enteredAt) {
    ProgressStudent* existing = map_.find(studentId);
    if (existing != nullptr) {
      existing->token = token;
      existing->score = score;
      existing->enteredAt = enteredAt;
      existing->version += 1;
      if (!existing->active) {
        existing->active = true;
        ++activeCount_;
      }
      heap_.push(ProgressHeapEntry{studentId, token, score, enteredAt, existing->version});
      return true;
    }

    ProgressStudent s;
    s.studentId = studentId;
    s.token = token;
    s.score = score;
    s.enteredAt = enteredAt;
    s.version = 1;
    s.active = true;
    map_.put(studentId, s);
    ++activeCount_;
    heap_.push(ProgressHeapEntry{studentId, token, score, enteredAt, s.version});
    return true;
  }

  // Removes a student from the active queue (e.g. upon 6/6 tasks approved).
  bool remove(long long studentId) {
    ProgressStudent* existing = map_.find(studentId);
    if (existing == nullptr || !existing->active) {
      return false;
    }
    existing->active = false;
    existing->version += 1;
    if (activeCount_ > 0) --activeCount_;
    return true;
  }

  // Wipes all entries.
  void clear() {
    map_.clear();
    heap_.clear();
    activeCount_ = 0;
  }

  std::size_t size() const { return activeCount_; }
  bool empty() const { return activeCount_ == 0; }

  const ProgressStudent* find(long long studentId) const {
    const ProgressStudent* s = map_.find(studentId);
    if (s != nullptr && s->active) return s;
    return nullptr;
  }

  bool contains(long long studentId) const {
    return find(studentId) != nullptr;
  }

  // Peeks at top active student without modifying heap order.
  const ProgressStudent* peek() {
    ProgressHeapEntry top;
    while (!heap_.empty()) {
      const ProgressHeapEntry* p = heap_.top();
      if (!p) return nullptr;
      ProgressStudent* cur = map_.find(p->studentId);
      if (cur != nullptr && cur->active && cur->version == p->version) {
        return cur;
      }
      heap_.pop(top); // Discard stale/inactive lazy entry
    }
    return nullptr;
  }

  // Returns all active students in exact max-heap order.
  std::vector<ProgressStudent> getRanked() {
    std::vector<ProgressStudent> out;
    if (activeCount_ == 0) return out;
    out.reserve(activeCount_);

    // Copy heap to drain non-destructively
    MinHeap<ProgressHeapEntry, ProgressScoreGreater> temp = heap_;
    ProgressHeapEntry top;
    while (temp.pop(top)) {
      ProgressStudent* cur = map_.find(top.studentId);
      if (cur != nullptr && cur->active && cur->version == top.version) {
        out.push_back(*cur);
      }
    }

    // Compaction if heap accumulated too many lazy-deleted entries
    if (heap_.size() > (activeCount_ * 2 + 50)) {
      rebuildHeap();
    }

    return out;
  }

 private:
  void rebuildHeap() {
    heap_.clear();
    map_.forEach([this](long long /*id*/, const ProgressStudent& s) {
      if (s.active) {
        heap_.push(ProgressHeapEntry{s.studentId, s.token, s.score, s.enteredAt, s.version});
      }
    });
  }

  MinHeap<ProgressHeapEntry, ProgressScoreGreater> heap_;
  HashMap<long long, ProgressStudent, IntHash> map_;
  std::size_t activeCount_;
};

}  // namespace admitflow

#endif
