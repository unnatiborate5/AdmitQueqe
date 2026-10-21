// AdmitFlow ProgressQueue Implementation (AdmissionProgressHeap)
//
// Implements the dedicated admission progress queue for CAP admissions.
// Ranking Formula:
//   Priority Score = (60% * Deadline Urgency) + (40% * Approved Task Progress)
//
// Data Structure:
// - Max-Heap (using MinHeap template with inverted greater-than comparator)
// - HashMap for O(1) student lookups, updates, and duplicate checks
// - FIFO tie-breaking: equal scores broken by earlier enteredAt ISO timestamp

#include <iostream>
#include <string>
#include <vector>
#include <algorithm>

#include "progress_queue.h"

using namespace std;

namespace admitflow {

// Constructor: initialize binary heap and hash map with initial capacity 64
AdmissionProgressHeap::AdmissionProgressHeap()
    : heap_(ProgressScoreGreater()), map_(64), activeCount_(0) {}

// Inserts a student or updates an existing student's score
bool AdmissionProgressHeap::upsert(long long studentId, const string& token,
                                   double score, const string& enteredAt) {
  ProgressStudent* existing = map_.find(studentId);

  // If student is already in the map, update record and bump version
  if (existing != nullptr) {
    existing->token = token;
    existing->score = score;
    existing->enteredAt = enteredAt;
    existing->version += 1;

    if (!existing->active) {
      existing->active = true;
      activeCount_++;
    }

    // Push new entry into heap with latest version
    heap_.push(ProgressHeapEntry{studentId, token, score, enteredAt, existing->version});
    return true;
  }

  // New student arrival: create new record
  ProgressStudent newStudent;
  newStudent.studentId = studentId;
  newStudent.token = token;
  newStudent.score = score;
  newStudent.enteredAt = enteredAt;
  newStudent.version = 1;
  newStudent.active = true;

  map_.put(studentId, newStudent);
  activeCount_++;

  heap_.push(ProgressHeapEntry{studentId, token, score, enteredAt, newStudent.version});
  return true;
}

// Removes a student from active queue upon completing all 6 admission tasks
bool AdmissionProgressHeap::remove(long long studentId) {
  ProgressStudent* existing = map_.find(studentId);
  if (existing == nullptr || !existing->active) {
    return false;
  }

  // Mark inactive and increment version to invalidate heap entries
  existing->active = false;
  existing->version += 1;

  if (activeCount_ > 0) {
    activeCount_--;
  }

  return true;
}

// Resets and clears all entries
void AdmissionProgressHeap::clear() {
  map_.clear();
  heap_.clear();
  activeCount_ = 0;
}

size_t AdmissionProgressHeap::size() const {
  return activeCount_;
}

bool AdmissionProgressHeap::empty() const {
  return activeCount_ == 0;
}

// Finds an active student by their ID
const ProgressStudent* AdmissionProgressHeap::find(long long studentId) const {
  const ProgressStudent* student = map_.find(studentId);
  if (student != nullptr && student->active) {
    return student;
  }
  return nullptr;
}

bool AdmissionProgressHeap::contains(long long studentId) const {
  return find(studentId) != nullptr;
}

// Peeks at the highest-priority student without removing them
const ProgressStudent* AdmissionProgressHeap::peek() {
  ProgressHeapEntry topEntry;

  while (!heap_.empty()) {
    const ProgressHeapEntry* candidate = heap_.top();
    if (!candidate) {
      return nullptr;
    }

    ProgressStudent* current = map_.find(candidate->studentId);
    if (current != nullptr && current->active && current->version == candidate->version) {
      return current;
    }

    // Lazy deletion: discard stale entry from heap
    heap_.pop(topEntry);
  }

  return nullptr;
}

// Returns all active students in descending order of priority
vector<ProgressStudent> AdmissionProgressHeap::getRanked() {
  vector<ProgressStudent> rankedList;
  if (activeCount_ == 0) {
    return rankedList;
  }

  rankedList.reserve(activeCount_);

  // Drain a copy of the heap non-destructively
  MinHeap<ProgressHeapEntry, ProgressScoreGreater> tempHeap = heap_;
  ProgressHeapEntry topEntry;

  while (tempHeap.pop(topEntry)) {
    ProgressStudent* current = map_.find(topEntry.studentId);
    if (current != nullptr && current->active && current->version == topEntry.version) {
      rankedList.push_back(*current);
    }
  }

  // Compact heap if too many lazy-deleted entries accumulated
  if (heap_.size() > (activeCount_ * 2 + 50)) {
    rebuildHeap();
  }

  return rankedList;
}

// Rebuilds clean heap from only active map entries
void AdmissionProgressHeap::rebuildHeap() {
  heap_.clear();
  map_.forEach([this](long long /*id*/, const ProgressStudent& student) {
    if (student.active) {
      heap_.push(ProgressHeapEntry{
          student.studentId, student.token, student.score, student.enteredAt, student.version});
    }
  });
}

}  // namespace admitflow

