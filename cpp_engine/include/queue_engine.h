// QueueEngine - Core token and queue management for physical document verification (Phase 4).
#ifndef ADMITFLOW_QUEUE_ENGINE_H
#define ADMITFLOW_QUEUE_ENGINE_H

#include <string>
#include <vector>

#include "dsa/fifo_queue.hpp"
#include "dsa/hash_map.hpp"
#include "dsa/min_heap.hpp"

namespace admitflow {

enum class Lane { Priority, Regular };
enum class Status { Waiting, Called, Serving };

struct Token {
  std::string code;          // e.g. "P003" / "R004": lane letter + arrival number
  int seq = 0;               // arrival number for the day (1, 2, 3, ...). Unique; decides fairness.
  int level = 3;             // 1 = highest priority ... 3 = regular
  Lane lane = Lane::Regular;
  Status status = Status::Waiting;
  int counterId = 0;         // counter that called this token (0 = none)
  long long studentId = 0;
  std::string appId;         // application ID
};

// A token as reported to the caller: position/ahead are only meaningful while the token is waiting.
struct TokenView {
  Token token;
  int position = 0;          // 1 = will be called next
  int ahead = 0;             // students that will be called before this one
  std::string finalStatus;   // "completed" / "no_show" / "cancelled" for tokens that just left the engine
};

struct Result {
  bool ok = true;
  std::string error;         // machine-readable code when !ok
  std::string message;
  bool hasToken = false;
  TokenView token;           // the main token of the operation (or the existing one for DUPLICATE_TOKEN)
  std::vector<TokenView> returned;  // tokens sent back to the waiting lanes (counter closed)
};

struct CounterView {
  int id = 0;
  bool open = true;
  bool hasToken = false;
  TokenView token;
};

struct Snapshot {
  int fairness = 3;
  int streak = 0;
  int lastSeq = 0;
  std::vector<CounterView> counters;
  std::vector<TokenView> waiting;   // in CALL order (position 1, 2, 3, ...)
  int priorityWaiting = 0;
  int regularWaiting = 0;
  int called = 0;
  int serving = 0;
};

class QueueEngine {
 public:
  explicit QueueEngine(int fairness = 3);

  // ---- configuration / restore -------------------------------------------------------------
  void reset(int fairness);
  void setLastSeq(int seq) { if (seq > lastSeq_) lastSeq_ = seq; }
  void setStreak(int streak) { streak_ = streak < 0 ? 0 : streak; }
  int streak() const { return streak_; }
  int fairness() const { return fairness_; }
  Result load(const Token& token);
  Result setCounter(int id, bool open);

  // ---- queue operations ---------------------------------------------------------------------
  Result enqueue(int level, long long studentId, const std::string& appId);
  Result callNext(int counterId);
  Result start(const std::string& code);
  Result complete(const std::string& code);
  Result noShow(const std::string& code);
  Result cancel(const std::string& code);

  // ---- lookups --------------------------------------------------------------------------------
  Result findByCode(const std::string& code) const;
  Result findByApplication(const std::string& appId) const;
  Snapshot snapshot() const;

  static std::string makeCode(int level, int seq);
  static const char* statusName(Status s);
  static const char* laneName(Lane l);

 private:
  struct HeapEntry { int level; int seq; std::string code; };
  struct HeapLess {
    bool operator()(const HeapEntry& a, const HeapEntry& b) const {
      if (a.level != b.level) return a.level < b.level;
      return a.seq < b.seq;
    }
  };
  struct RegularEntry { int seq; std::string code; };
  struct Counter { int id = 0; bool open = true; std::string current; };

  using PriorityHeap = MinHeap<HeapEntry, HeapLess>;

  std::vector<std::string> callOrder() const;
  bool isLiveEntry(const HeapEntry& e) const;
  Token* popNext();
  void addToLane(const Token& t);
  void leaveWaiting(const Token& t);
  void finish(const std::string& code, Counter* counter);
  TokenView view(const Token& t, const std::vector<std::string>* order) const;
  TokenView finished(const Token& t, const char* finalStatus) const;
  static Result fail(const char* error, const std::string& message);
  static Result okWith(const TokenView& v);

  int fairness_;
  int streak_ = 0;
  int lastSeq_ = 0;
  int priorityWaiting_ = 0;
  int regularWaiting_ = 0;

  HashMap<std::string, Token, StringHash> tokens_;
  HashMap<std::string, std::string, StringHash> appIndex_;
  HashMap<long long, Counter, IntHash> counters_;
  std::vector<int> counterIds_;
  PriorityHeap priorityLane_;
  FifoQueue<RegularEntry> regularLane_;
};

}  // namespace admitflow

#endif

