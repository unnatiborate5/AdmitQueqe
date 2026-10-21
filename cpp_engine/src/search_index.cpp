// AdmitFlow SearchIndex Implementation
// Demonstrates Binary Search (O(log n)) for application IDs & tokens,
// and Linear Search (O(n)) for name substring search.

#include <iostream>
#include <string>
#include <vector>
#include <algorithm>
#include <cctype>

#include "search_index.h"
#include "algo/merge_sort.hpp"
#include "algo/search.hpp"

using namespace std;

namespace admitflow {

// Converts string to uppercase
string SearchIndex::upper(const string& input) {
  string result = input;
  for (size_t i = 0; i < result.size(); i++) {
    result[i] = static_cast<char>(toupper(static_cast<unsigned char>(result[i])));
  }
  return result;
}

// Converts string to lowercase
string SearchIndex::lower(const string& input) {
  string result = input;
  for (size_t i = 0; i < result.size(); i++) {
    result[i] = static_cast<char>(tolower(static_cast<unsigned char>(result[i])));
  }
  return result;
}

// Resets search index buffers
void SearchIndex::clear() {
  students_.clear();
  tokens_.clear();
  built_ = false;
}

// Adds student record to index buffer
void SearchIndex::addStudent(long long studentId, const string& applicationId,
                             const string& studentName) {
  students_.push_back(StudentRec{studentId, upper(applicationId), lower(studentName)});
  built_ = false;
}

// Adds queue token to index buffer
void SearchIndex::addToken(int tokenNumber, char laneLetter, long long studentId) {
  char upperLane = static_cast<char>(toupper(static_cast<unsigned char>(laneLetter)));
  tokens_.push_back(TokenRec{tokenNumber, upperLane, studentId});
  built_ = false;
}

// Builds the index using stable Merge Sort so that binary search can be applied
size_t SearchIndex::build() {
  size_t comparisons = mergeSort(students_, [](const StudentRec& a, const StudentRec& b) {
    return a.appKey < b.appKey;
  });

  comparisons += mergeSort(tokens_, [](const TokenRec& a, const TokenRec& b) {
    return a.number < b.number;
  });

  built_ = true;
  return comparisons;
}

// Searches students by application ID prefix using Binary Search [lowerBound, upperBound)
vector<long long> SearchIndex::findByApplicationPrefix(const string& rawPrefix,
                                                       SearchStats& stats) const {
  string prefix = upper(rawPrefix);
  stats.algorithm = "binary search";
  stats.size = students_.size();
  stats.comparisons = 0;

  vector<long long> matches;
  if (prefix.empty()) {
    return matches;
  }

  // Find first record with key >= prefix
  size_t lowerBoundIndex = lowerBound(
      students_, prefix,
      [](const StudentRec& student, const string& p) {
        return student.appKey < p;
      },
      stats.comparisons);

  // Find first record strictly greater than prefix that does NOT start with prefix
  size_t upperBoundIndex = upperBound(
      students_, prefix,
      [](const string& p, const StudentRec& student) {
        return p < student.appKey && student.appKey.compare(0, p.size(), p) != 0;
      },
      stats.comparisons);

  for (size_t i = lowerBoundIndex; i < upperBoundIndex; i++) {
    matches.push_back(students_[i].id);
  }

  return matches;
}

// Searches token by code using Binary Search over numerical sequence
bool SearchIndex::findToken(const string& rawCode, long long& studentId,
                            SearchStats& stats) const {
  stats.algorithm = "binary search";
  stats.size = tokens_.size();
  stats.comparisons = 0;

  if (rawCode.size() < 2) {
    return false;
  }

  char targetLane = static_cast<char>(toupper(static_cast<unsigned char>(rawCode[0])));
  int targetNumber = 0;

  for (size_t i = 1; i < rawCode.size(); i++) {
    if (!isdigit(static_cast<unsigned char>(rawCode[i])) || targetNumber > 100000000) {
      return false;
    }
    targetNumber = targetNumber * 10 + (rawCode[i] - '0');
  }

  // Binary search for token number
  size_t pos = lowerBound(
      tokens_, targetNumber,
      [](const TokenRec& token, int num) {
        return token.number < num;
      },
      stats.comparisons);

  if (pos < tokens_.size() &&
      tokens_[pos].number == targetNumber &&
      tokens_[pos].lane == targetLane) {
    studentId = tokens_[pos].studentId;
    return true;
  }

  return false;
}

// Searches students by name substring using Linear Search (O(n))
vector<long long> SearchIndex::findByName(const string& fragment,
                                          SearchStats& stats) const {
  stats.algorithm = "linear search";
  stats.size = students_.size();
  stats.comparisons = 0;

  vector<long long> matches;
  string needle = lower(fragment);

  if (needle.empty()) {
    return matches;
  }

  // Linear scan across all records
  vector<size_t> matchedIndices = linearSearchAll(
      students_,
      [&](const StudentRec& student) {
        return student.nameLower.find(needle) != string::npos;
      },
      stats.comparisons);

  for (size_t index : matchedIndices) {
    matches.push_back(students_[index].id);
  }

  return matches;
}

}  // namespace admitflow
