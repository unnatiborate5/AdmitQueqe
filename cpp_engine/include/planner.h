// Planner - ranks admin worklists with stable Merge Sort.
#ifndef ADMITFLOW_PLANNER_H
#define ADMITFLOW_PLANNER_H

#include <cstddef>
#include <string>
#include <vector>

namespace admitflow {

struct WorkItem {
  long long id = 0;
  int level = 3;             // 1 most urgent .. 3 regular
  int minutes = 0;           // appointment time, minutes after midnight
  int token = 0;             // queue token number, 0 = not checked in
  long long waitKey = 0;     // when the student started waiting (epoch seconds); smaller = waited longer
  std::string name;          // stored lower-case
};

enum class SortMode { Unscheduled, ArrivalsTime, ArrivalsPriority, ArrivalsToken };

bool parseSortMode(const std::string& name, SortMode& out);
std::size_t sortWork(std::vector<WorkItem>& items, SortMode mode);

}  // namespace admitflow

#endif

