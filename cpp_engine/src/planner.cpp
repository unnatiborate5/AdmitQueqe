#include "planner.hpp"

#include <climits>

#include "algo/merge_sort.hpp"

namespace admitflow {

bool parseSortMode(const std::string& name, SortMode& out) {
  if (name == "unscheduled") out = SortMode::Unscheduled;
  else if (name == "arrivals_time") out = SortMode::ArrivalsTime;
  else if (name == "arrivals_priority") out = SortMode::ArrivalsPriority;
  else if (name == "arrivals_token") out = SortMode::ArrivalsToken;
  else return false;
  return true;
}

namespace {
// Three-way helper: <0, 0, >0
template <typename T> int cmp(const T& a, const T& b) { return a < b ? -1 : (b < a ? 1 : 0); }
}  // namespace

std::size_t sortWork(std::vector<WorkItem>& items, SortMode mode) {
  switch (mode) {
    case SortMode::Unscheduled:
      return mergeSort(items, [](const WorkItem& a, const WorkItem& b) {
        if (int c = cmp(a.level, b.level)) return c < 0;
        if (int c = cmp(a.waitKey, b.waitKey)) return c < 0;
        return a.name < b.name;
      });
    case SortMode::ArrivalsTime:
      return mergeSort(items, [](const WorkItem& a, const WorkItem& b) {
        if (int c = cmp(a.minutes, b.minutes)) return c < 0;
        if (int c = cmp(a.level, b.level)) return c < 0;
        return a.name < b.name;
      });
    case SortMode::ArrivalsPriority:
      return mergeSort(items, [](const WorkItem& a, const WorkItem& b) {
        if (int c = cmp(a.level, b.level)) return c < 0;
        if (int c = cmp(a.minutes, b.minutes)) return c < 0;
        return a.name < b.name;
      });
    case SortMode::ArrivalsToken:
    default:
      return mergeSort(items, [](const WorkItem& a, const WorkItem& b) {
        const int ta = a.token == 0 ? INT_MAX : a.token, tb = b.token == 0 ? INT_MAX : b.token;   // not checked in -> last
        if (int c = cmp(ta, tb)) return c < 0;
        if (int c = cmp(a.minutes, b.minutes)) return c < 0;
        return a.name < b.name;
      });
  }
}

}  // namespace admitflow
