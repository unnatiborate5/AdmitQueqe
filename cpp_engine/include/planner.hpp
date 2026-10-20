// Planner - ranks the admin worklists with MERGE SORT.
//
//   unscheduled        students who still need a verification appointment: who should be booked FIRST?
//                      returning students (priority 1) before late-round students (2) before regular (3);
//                      within a level, the student who has waited longest; then by name.
//   arrivals_time      today's appointments in the order students are expected: by appointment time,
//                      then priority level, then name.
//   arrivals_priority  the same list, most urgent first: by priority level, then time, then name.
//   arrivals_token     the same list by queue token: students already checked in (lowest token first),
//                      then students who have not arrived yet (by time).
// The priority level comes from the Phase 4 priority policy (computed by the backend); this file only orders.
#ifndef ADMITFLOW_PLANNER_HPP
#define ADMITFLOW_PLANNER_HPP

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
std::size_t sortWork(std::vector<WorkItem>& items, SortMode mode);   // returns merge-sort comparisons

}  // namespace admitflow

#endif
