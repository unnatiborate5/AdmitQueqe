// HashMap - a hash table with separate chaining and automatic rehashing.
//
// WHERE IT IS USED (three places in QueueEngine):
//   tokens_   : token code        -> token   (every Start / Complete / No-show / Cancel / lookup by token ID)
//   appIndex_ : application ID    -> token code of the student's ACTIVE token
//                (lookup by application ID, AND the O(1) duplicate-token check at check-in)
//   counters_ : counter number    -> counter state
// WHY A HASH MAP: every desk action arrives with an ID, never with a queue position. Finding the token
// in the queues by scanning would cost O(n) per action; the map finds it in O(1) on average.
//
// Nodes are allocated individually and re-linked (never copied) on rehash, so pointers returned by
// find() stay valid until that key is erased.
#ifndef ADMITFLOW_HASH_MAP_HPP
#define ADMITFLOW_HASH_MAP_HPP

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace admitflow {

struct StringHash {  // FNV-1a
  std::size_t operator()(const std::string& s) const {
    std::uint64_t h = 1469598103934665603ULL;
    for (unsigned char c : s) { h ^= c; h *= 1099511628211ULL; }
    return static_cast<std::size_t>(h);
  }
};

struct IntHash {
  std::size_t operator()(long long v) const {
    std::uint64_t x = static_cast<std::uint64_t>(v);
    x ^= x >> 33; x *= 0xff51afd7ed558ccdULL; x ^= x >> 33;
    return static_cast<std::size_t>(x);
  }
};

template <typename K, typename V, typename Hash>
class HashMap {
 public:
  explicit HashMap(std::size_t initialBuckets = 16) : buckets_(initialBuckets < 4 ? 4 : initialBuckets, nullptr) {}
  ~HashMap() { clear(); }
  HashMap(const HashMap&) = delete;
  HashMap& operator=(const HashMap&) = delete;

  // Inserts or overwrites. Returns a pointer to the stored value.
  V* put(const K& key, const V& value) {
    V* existing = find(key);
    if (existing != nullptr) { *existing = value; return existing; }
    if ((size_ + 1) * 4 > buckets_.size() * 3) rehash(buckets_.size() * 2);   // keep load factor <= 0.75
    std::size_t i = indexOf(key, buckets_.size());
    Node* n = new Node{key, value, buckets_[i]};
    buckets_[i] = n;
    ++size_;
    return &n->value;
  }

  V* find(const K& key) {
    for (Node* n = buckets_[indexOf(key, buckets_.size())]; n != nullptr; n = n->next)
      if (n->key == key) return &n->value;
    return nullptr;
  }
  const V* find(const K& key) const {
    for (const Node* n = buckets_[indexOf(key, buckets_.size())]; n != nullptr; n = n->next)
      if (n->key == key) return &n->value;
    return nullptr;
  }

  bool contains(const K& key) const { return find(key) != nullptr; }

  bool erase(const K& key) {
    std::size_t i = indexOf(key, buckets_.size());
    Node* prev = nullptr;
    for (Node* n = buckets_[i]; n != nullptr; prev = n, n = n->next) {
      if (n->key == key) {
        if (prev == nullptr) buckets_[i] = n->next; else prev->next = n->next;
        delete n;
        --size_;
        return true;
      }
    }
    return false;
  }

  template <typename F>
  void forEach(F f) const {
    for (Node* head : buckets_)
      for (Node* n = head; n != nullptr; n = n->next) f(n->key, n->value);
  }

  std::size_t size() const { return size_; }
  bool empty() const { return size_ == 0; }
  std::size_t bucketCount() const { return buckets_.size(); }

  void clear() {
    for (Node*& head : buckets_) {
      while (head != nullptr) { Node* n = head; head = n->next; delete n; }
    }
    size_ = 0;
  }

 private:
  struct Node { K key; V value; Node* next; };

  std::size_t indexOf(const K& key, std::size_t buckets) const { return Hash()(key) % buckets; }

  void rehash(std::size_t newCount) {
    std::vector<Node*> next(newCount, nullptr);
    for (Node* head : buckets_) {
      while (head != nullptr) {
        Node* n = head;
        head = n->next;
        std::size_t i = indexOf(n->key, newCount);
        n->next = next[i];
        next[i] = n;
      }
    }
    buckets_.swap(next);
  }

  std::vector<Node*> buckets_;
  std::size_t size_ = 0;
};

}  // namespace admitflow

#endif
