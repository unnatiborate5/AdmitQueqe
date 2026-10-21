// Toolkit - Phase 4 Queue Engine + Phase 5 Syllabus Features
#ifndef ADMITFLOW_TOOLKIT_H
#define ADMITFLOW_TOOLKIT_H

#include <string>

#include "progress_queue.h"
#include "queue_engine.h"
#include "search_index.h"
#include "undo_stacks.h"

namespace admitflow {

struct Toolkit {
  explicit Toolkit(int fairness = 3) : queue(fairness), undo(20) {}
  QueueEngine queue;                // Phase 4: physical verification queue
  SearchIndex index;                // Phase 5: searching (binary / linear)
  UndoStacks undo;                  // Phase 5: per-admin undo stack
  AdmissionProgressHeap progress;   // Dedicated permanent admission-progress max-heap
};

std::string handleToolkitLine(Toolkit& toolkit, const std::string& line, bool& quit);

}  // namespace admitflow

#endif

