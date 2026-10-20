#include "search_index.hpp"

#include <cctype>

#include "algo/merge_sort.hpp"
#include "algo/search.hpp"

namespace admitflow {

std::string SearchIndex::upper(const std::string& s) {
  std::string out = s;
  for (char& c : out) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
  return out;
}

std::string SearchIndex::lower(const std::string& s) {
  std::string out = s;
  for (char& c : out) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return out;
}

void SearchIndex::clear() {
  students_.clear();
  tokens_.clear();
  built_ = false;
}

void SearchIndex::addStudent(long long studentId, const std::string& applicationId, const std::string& name) {
  students_.push_back(StudentRec{studentId, upper(applicationId), lower(name)});
  built_ = false;
}

void SearchIndex::addToken(int number, char lane, long long studentId) {
  tokens_.push_back(TokenRec{number, static_cast<char>(std::toupper(static_cast<unsigned char>(lane))), studentId});
  built_ = false;
}

// Binary search needs sorted data, so sorting is part of building the index.
std::size_t SearchIndex::build() {
  std::size_t cmp = mergeSort(students_, [](const StudentRec& a, const StudentRec& b) { return a.appKey < b.appKey; });
  cmp += mergeSort(tokens_, [](const TokenRec& a, const TokenRec& b) { return a.number < b.number; });
  built_ = true;
  return cmp;
}

std::vector<long long> SearchIndex::findByApplicationPrefix(const std::string& rawPrefix, SearchStats& stats) const {
  const std::string prefix = upper(rawPrefix);
  stats.algorithm = "binary search";
  stats.size = students_.size();
  stats.comparisons = 0;
  std::vector<long long> out;
  if (prefix.empty()) return out;
  // first ID >= prefix
  const std::size_t lo = lowerBound(students_, prefix, [](const StudentRec& s, const std::string& p) { return s.appKey < p; }, stats.comparisons);
  // first ID that is greater than the prefix AND does not start with it: everything in [lo, hi) starts with the prefix
  const std::size_t hi = upperBound(students_, prefix, [](const std::string& p, const StudentRec& s) {
    return p < s.appKey && s.appKey.compare(0, p.size(), p) != 0;
  }, stats.comparisons);
  for (std::size_t i = lo; i < hi; ++i) out.push_back(students_[i].id);
  return out;
}

bool SearchIndex::findToken(const std::string& rawCode, long long& studentId, SearchStats& stats) const {
  stats.algorithm = "binary search";
  stats.size = tokens_.size();
  stats.comparisons = 0;
  if (rawCode.size() < 2) return false;
  const char lane = static_cast<char>(std::toupper(static_cast<unsigned char>(rawCode[0])));
  int number = 0;
  for (std::size_t i = 1; i < rawCode.size(); ++i) {
    if (!std::isdigit(static_cast<unsigned char>(rawCode[i])) || number > 100000000) return false;
    number = number * 10 + (rawCode[i] - '0');
  }
  const std::size_t pos = lowerBound(tokens_, number, [](const TokenRec& t, int n) { return t.number < n; }, stats.comparisons);
  if (pos < tokens_.size() && tokens_[pos].number == number && tokens_[pos].lane == lane) {
    studentId = tokens_[pos].studentId;
    return true;
  }
  return false;
}

std::vector<long long> SearchIndex::findByName(const std::string& fragment, SearchStats& stats) const {
  stats.algorithm = "linear search";
  stats.size = students_.size();
  stats.comparisons = 0;
  std::vector<long long> out;
  const std::string needle = lower(fragment);
  if (needle.empty()) return out;
  for (std::size_t i : linearSearchAll(students_, [&](const StudentRec& s) { return s.nameLower.find(needle) != std::string::npos; }, stats.comparisons)) {
    out.push_back(students_[i].id);
  }
  return out;
}

}  // namespace admitflow
