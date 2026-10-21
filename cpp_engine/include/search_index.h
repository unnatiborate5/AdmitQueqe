// SearchIndex - Binary search over IDs / tokens, Linear search over names.
#ifndef ADMITFLOW_SEARCH_INDEX_H
#define ADMITFLOW_SEARCH_INDEX_H

#include <string>
#include <vector>
#include <cstddef>

namespace admitflow {

struct SearchStats {
  std::string algorithm;
  std::size_t comparisons = 0;
  std::size_t size = 0;
};

class SearchIndex {
 public:
  void clear();
  void addStudent(long long studentId, const std::string& applicationId, const std::string& name);
  void addToken(int number, char lane, long long studentId);
  std::size_t build();
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
  std::vector<StudentRec> students_;
  std::vector<TokenRec> tokens_;
  bool built_ = false;
};

}  // namespace admitflow

#endif

