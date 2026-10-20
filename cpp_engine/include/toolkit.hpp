// Toolkit - everything the engine process owns: the Phase 4 queue engine plus the Phase 5 syllabus features.
// The Phase 4 queue commands are passed through untouched to handleLine(); this layer only adds new commands.
//
// Phase 5 commands (one request line -> one JSON reply line):
//   INDEX_CLEAR | INDEX_ADD <n> id:APPID:name ... | INDEX_TOKENS <n> number:lane:studentId ... | INDEX_BUILD
//   SEARCH_APP <prefix> | SEARCH_TOKEN <code> | SEARCH_NAME <fragment>        (names use '~' for a space)
//   SORT <mode> <n> id:level:minutes:token:waitKey:name ...
//   STACK_PUSH <admin> <actionId> <studentId> <kind> | STACK_POP <admin> | STACK_PEEK <admin> | STACK_LIST <admin> | STACK_CLEAR_ALL
//   APPT_LOAD <rows> <cols> <fromCol> <toCol> <n> day:slot ...
//   DOC_READINESS <docs> <rounds> <roundTotal...> <n> doc:round:count ...
#ifndef ADMITFLOW_TOOLKIT_HPP
#define ADMITFLOW_TOOLKIT_HPP

#include <string>

#include "admission_progress_heap.hpp"
#include "queue_engine.hpp"
#include "search_index.hpp"
#include "undo_stacks.hpp"

namespace admitflow {

struct Toolkit {
  explicit Toolkit(int fairness = 3) : queue(fairness), undo(20) {}
  QueueEngine queue;                // Phase 4: tokens, lanes, counters
  SearchIndex index;                // Phase 5: searching (binary / linear) over a merge-sorted index
  UndoStacks undo;                  // Phase 5: stack of reversible admin actions per admin
  AdmissionProgressHeap progress;   // Dedicated permanent admission-progress max-heap
};

std::string handleToolkitLine(Toolkit& toolkit, const std::string& line, bool& quit);

}  // namespace admitflow

#endif
