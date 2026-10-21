// AdmitFlow Planner Implementation
// Ranks admin worklists using stable Merge Sort (O(n log n)).

#include <iostream>
#include <string>
#include <vector>
#include <algorithm>
#include <climits>

#include "planner.h"
#include "algo/merge_sort.hpp"

using namespace std;

namespace admitflow {

// Parses the sort mode string into SortMode enum
bool parseSortMode(const string& name, SortMode& out) {
  if (name == "unscheduled") {
    out = SortMode::Unscheduled;
    return true;
  }
  if (name == "arrivals_time") {
    out = SortMode::ArrivalsTime;
    return true;
  }
  if (name == "arrivals_priority") {
    out = SortMode::ArrivalsPriority;
    return true;
  }
  if (name == "arrivals_token") {
    out = SortMode::ArrivalsToken;
    return true;
  }
  return false;
}

// Sorts items using stable Merge Sort based on the selected mode
size_t sortWork(vector<WorkItem>& items, SortMode mode) {
  switch (mode) {
    case SortMode::Unscheduled:
      // Priority 1: Priority level (1 is most urgent, 3 is regular)
      // Priority 2: Waiting time (smaller waitKey = earlier epoch timestamp = waited longer)
      // Priority 3: Student name (alphabetical)
      return mergeSort(items, [](const WorkItem& a, const WorkItem& b) {
        if (a.level != b.level) {
          return a.level < b.level;
        }
        if (a.waitKey != b.waitKey) {
          return a.waitKey < b.waitKey;
        }
        return a.name < b.name;
      });

    case SortMode::ArrivalsTime:
      // Priority 1: Appointment time (minutes after midnight)
      // Priority 2: Priority level
      // Priority 3: Student name
      return mergeSort(items, [](const WorkItem& a, const WorkItem& b) {
        if (a.minutes != b.minutes) {
          return a.minutes < b.minutes;
        }
        if (a.level != b.level) {
          return a.level < b.level;
        }
        return a.name < b.name;
      });

    case SortMode::ArrivalsPriority:
      // Priority 1: Priority level
      // Priority 2: Appointment time
      // Priority 3: Student name
      return mergeSort(items, [](const WorkItem& a, const WorkItem& b) {
        if (a.level != b.level) {
          return a.level < b.level;
        }
        if (a.minutes != b.minutes) {
          return a.minutes < b.minutes;
        }
        return a.name < b.name;
      });

    case SortMode::ArrivalsToken:
    default:
      // Priority 1: Token number (students not checked in have token == 0, placed at end)
      // Priority 2: Appointment time
      // Priority 3: Student name
      return mergeSort(items, [](const WorkItem& a, const WorkItem& b) {
        int tokenA = (a.token == 0) ? INT_MAX : a.token;
        int tokenB = (b.token == 0) ? INT_MAX : b.token;
        if (tokenA != tokenB) {
          return tokenA < tokenB;
        }
        if (a.minutes != b.minutes) {
          return a.minutes < b.minutes;
        }
        return a.name < b.name;
      });
  }
}

}  // namespace admitflow
