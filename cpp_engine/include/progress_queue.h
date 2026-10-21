// ProgressQueue (AdmissionProgressHeap)
//
// Implements the dedicated CAP admission progress max-heap queue.
// Orders students by priority score (60% deadline urgency + 40% task progress).
// Ties broken by earlier queue arrival timestamp (FIFO).
// Completed students (all 6 tasks approved) are removed from this active queue.
#ifndef ADMITFLOW_PROGRESS_QUEUE_H
#define ADMITFLOW_PROGRESS_QUEUE_H

#include <cstddef>
#include <string>
#include <vector>

#include "dsa/hash_map.hpp"
#include "dsa/min_heap.hpp"

namespace admitflow {

// Entry stored in the MinHeap
struct ProgressHeapEntry {
  long long studentId = 0;
  std::string token;
  double score = 0.0;
  std::string enteredAt;
  long long version = 0;
};

// Max-priority comparator for the heap:
// Returns true when 'a' should come out BEFORE 'b'.
// 1. Higher score first (difference > 1e-7).
// 2. Equal score: earlier enteredAt timestamp (FIFO).
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

    // Fallback: deterministic by studentId
    return a.studentId < b.studentId;
  }
};

// Canonical student record stored in the hash map
struct ProgressStudent {
  long long studentId = 0;
  std::string token;
  double score = 0.0;
  std::string enteredAt;
  long long version = 0;
  bool active = true;
};

// AdmissionProgressHeap (also aliased as ProgressQueue)
// Combines a binary heap with a hash map for O(1) lookups and O(log n) priority updates.
class AdmissionProgressHeap {
 public:
  AdmissionProgressHeap();

  // Inserts a new student or updates existing student priority score
  bool upsert(long long studentId, const std::string& token, double score, const std::string& enteredAt);

  // Removes student from active queue upon admission completion
  bool remove(long long studentId);

  // Clears all records
  void clear();

  std::size_t size() const;
  bool empty() const;

  const ProgressStudent* find(long long studentId) const;
  bool contains(long long studentId) const;

  // Peeks at highest-priority student (skips stale lazy-deleted entries)
  const ProgressStudent* peek();

  // Returns all active students in exact priority order
  std::vector<ProgressStudent> getRanked();

 private:
  void rebuildHeap();

  MinHeap<ProgressHeapEntry, ProgressScoreGreater> heap_;
  HashMap<long long, ProgressStudent, IntHash> map_;
  std::size_t activeCount_;
};

// Convenient alias for clean student OOP code
using ProgressQueue = AdmissionProgressHeap;

}  // namespace admitflow

#endif

