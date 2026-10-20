// SearchIndex - the data behind the admin "search everything" box.
//
// Three lookups, each with the algorithm that fits its data:
//
//   application ID  ->  BINARY SEARCH over students sorted by application ID (built with MERGE SORT).
//                       A typed prefix such as "MH2026-100" is the contiguous range [lowerBound, upperBound).
//   token code      ->  BINARY SEARCH over today's tokens sorted by token number ("R012" -> number 12, lane R).
//   student name    ->  LINEAR SEARCH for a substring. Text fragments have no order to exploit.
//
// The backend loads the data (INDEX_ADD / INDEX_TOKENS), calls build() once, and rebuilds only when the underlying
// records change. Every search reports the comparisons it made.
#ifndef ADMITFLOW_SEARCH_INDEX_HPP
#define ADMITFLOW_SEARCH_INDEX_HPP

#include <string>
#include <vector>

namespace admitflow {

struct SearchStats {
  std::string algorithm;
  std::size_t comparisons = 0;   // binary search: halving steps; linear search: records examined
  std::size_t size = 0;          // records searched
};

class SearchIndex {
 public:
  void clear();
  void addStudent(long long studentId, const std::string& applicationId, const std::string& name);
  void addToken(int number, char lane, long long studentId);
  std::size_t build();           // sorts both arrays (merge sort); returns the sort's comparison count
  bool built() const { return built_; }
  std::size_t students() const { return students_.size(); }
  std::size_t tokens() const { return tokens_.size(); }

  std::vector<long long> findByApplicationPrefix(const std::string& prefix, SearchStats& stats) const;
  bool findToken(const std::string& code, long long& studentId, SearchStats& stats) const;
  std::vector<long long> findByName(const std::string& fragment, SearchStats& stats) const;

  static std::string upper(const std::string& s);
  static std::string lower(const std::string& s);

 private:
  struct StudentRec { long long id; std::string appKey; std::string nameLower; };
  struct TokenRec { int number; char lane; long long studentId; };
  std::vector<StudentRec> students_;   // sorted by appKey after build()
  std::vector<TokenRec> tokens_;       // sorted by number after build()
  bool built_ = false;
};

}  // namespace admitflow

#endif
