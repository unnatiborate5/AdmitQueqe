// AdmitFlow Toolkit Protocol Implementation
//
// Implements the text protocol handlers for Phase 5 DSA Syllabus Features:
// 1. Searching (Binary Search over Application IDs/Tokens, Linear Search over Names)
// 2. Sorting (Merge Sort for Admin Worklist Planner)
// 3. Stack (LIFO Undo Stack per Admin for reversible actions)
// 4. Sparse Matrix (Appointment Load Grid: Days x Time Slots)
// 5. Dense Matrix (Document Readiness Grid: Documents x CAP Rounds)
// 6. Max-Heap Priority Queue (Admission Progress Queue with FIFO tie-breaking)
//
// Any non-toolkit command is transparently forwarded to the Phase 4 Queue Engine.

#include "toolkit.hpp"

#include <cstdio>
#include <cstdlib>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include "planner.hpp"
#include "protocol.hpp"
#include "reports.hpp"

namespace admitflow {

namespace {

// Splits a string by delimiter character
std::vector<std::string> splitString(const std::string& input, char delimiter) {
  std::vector<std::string> tokens;
  std::string currentSegment;
  for (char ch : input) {
    if (ch == delimiter) {
      tokens.push_back(currentSegment);
      currentSegment.clear();
    } else {
      currentSegment += ch;
    }
  }
  tokens.push_back(currentSegment);
  return tokens;
}

// Parses 64-bit integer from string
bool parseLongLong(const std::string& str, long long& result) {
  if (str.empty()) {
    return false;
  }
  char* endPointer = nullptr;
  long long value = std::strtoll(str.c_str(), &endPointer, 10);
  if (endPointer == str.c_str() || *endPointer != '\0') {
    return false;
  }
  result = value;
  return true;
}

// Parses floating-point double from string
bool parseDouble(const std::string& str, double& result) {
  if (str.empty()) {
    return false;
  }
  char* endPointer = nullptr;
  double value = std::strtod(str.c_str(), &endPointer);
  if (endPointer == str.c_str() || *endPointer != '\0') {
    return false;
  }
  result = value;
  return true;
}

// Replaces tilde characters '~' with spaces in student names
std::string decodeSpaces(std::string text) {
  for (char& ch : text) {
    if (ch == '~') {
      ch = ' ';
    }
  }
  return text;
}

// Creates standard JSON error response
std::string makeError(const std::string& errorCode, const std::string& errorMessage) {
  return "{\"ok\":false,\"error\":\"" + jsonEscape(errorCode) +
         "\",\"message\":\"" + jsonEscape(errorMessage) + "\"}";
}

// Serializes a vector of IDs into a JSON array: [1,2,3]
std::string formatIdList(const std::vector<long long>& ids) {
  std::string json = "[";
  for (std::size_t i = 0; i < ids.size(); ++i) {
    if (i > 0) {
      json += ",";
    }
    json += std::to_string(ids[i]);
  }
  json += "]";
  return json;
}

// Serializes search algorithm metrics into JSON fragment
std::string formatSearchStats(const SearchStats& stats) {
  return "\"algorithm\":\"" + stats.algorithm +
         "\",\"comparisons\":" + std::to_string(stats.comparisons) +
         ",\"size\":" + std::to_string(stats.size);
}

// Serializes an UndoEntry struct into JSON
std::string formatUndoEntry(const UndoEntry& entry) {
  return "{\"actionId\":" + std::to_string(entry.actionId) +
         ",\"studentId\":" + std::to_string(entry.studentId) +
         ",\"kind\":\"" + jsonEscape(entry.kind) + "\"}";
}

// Generic helper to serialize a vector of items with a custom formatting function
template <typename T, typename Formatter>
std::string formatArray(const std::vector<T>& items, Formatter formatFn) {
  std::string json = "[";
  for (std::size_t i = 0; i < items.size(); ++i) {
    if (i > 0) {
      json += ",";
    }
    json += formatFn(items[i]);
  }
  json += "]";
  return json;
}

const std::size_t MAX_ALLOWED_ITEMS = 20000;

// Validates and extracts a batch list of items starting at index `countIndex`:
// Format: <cmd> ... <itemCount> item1 item2 ... itemN
bool extractItems(const std::vector<std::string>& arguments, std::size_t countIndex,
                  std::vector<std::string>& extractedItems, std::string& errorMessage) {
  long long count = 0;
  if (arguments.size() <= countIndex ||
      !parseLongLong(arguments[countIndex], count) ||
      count < 0 ||
      static_cast<std::size_t>(count) > MAX_ALLOWED_ITEMS ||
      arguments.size() != countIndex + 1 + static_cast<std::size_t>(count)) {
    errorMessage = makeError("BAD_ARGUMENT", "Item count does not match the items given.");
    return false;
  }
  extractedItems.assign(arguments.begin() + static_cast<std::ptrdiff_t>(countIndex) + 1,
                        arguments.end());
  return true;
}

// -----------------------------------------------------------------------------
// Subsystem 1: Search Index Commands
// -----------------------------------------------------------------------------

std::string handleSearchIndexCommands(Toolkit& tk, const std::string& command,
                                      const std::vector<std::string>& arguments) {
  if (command == "INDEX_CLEAR") {
    tk.index.clear();
    return "{\"ok\":true}";
  }

  if (command == "INDEX_ADD") {
    std::string errorMessage;
    std::vector<std::string> rawItems;
    if (!extractItems(arguments, 1, rawItems, errorMessage)) {
      return errorMessage;
    }

    for (const std::string& itemStr : rawItems) {
      std::vector<std::string> fields = splitString(itemStr, ':');
      long long studentId = 0;
      if (fields.size() != 3 || !parseLongLong(fields[0], studentId) || fields[1].empty()) {
        return makeError("BAD_ARGUMENT", "INDEX_ADD item: id:APPID:name");
      }
      tk.index.addStudent(studentId, fields[1], decodeSpaces(fields[2]));
    }
    return "{\"ok\":true,\"added\":" + std::to_string(rawItems.size()) + "}";
  }

  if (command == "INDEX_TOKENS") {
    std::string errorMessage;
    std::vector<std::string> rawItems;
    if (!extractItems(arguments, 1, rawItems, errorMessage)) {
      return errorMessage;
    }

    for (const std::string& itemStr : rawItems) {
      std::vector<std::string> fields = splitString(itemStr, ':');
      long long tokenNumber = 0;
      long long studentId = 0;
      if (fields.size() != 3 || !parseLongLong(fields[0], tokenNumber) ||
          fields[1].size() != 1 || !parseLongLong(fields[2], studentId)) {
        return makeError("BAD_ARGUMENT", "INDEX_TOKENS item: number:lane:studentId");
      }
      tk.index.addToken(static_cast<int>(tokenNumber), fields[1][0], studentId);
    }
    return "{\"ok\":true,\"added\":" + std::to_string(rawItems.size()) + "}";
  }

  if (command == "INDEX_BUILD") {
    std::size_t comparisons = tk.index.build();
    return "{\"ok\":true,\"students\":" + std::to_string(tk.index.students()) +
           ",\"tokens\":" + std::to_string(tk.index.tokens()) +
           ",\"algorithm\":\"merge sort\",\"comparisons\":" + std::to_string(comparisons) + "}";
  }

  if (command == "SEARCH_APP" || command == "SEARCH_TOKEN" || command == "SEARCH_NAME") {
    if (arguments.size() != 2) {
      return makeError("BAD_ARGUMENT", command + " <value>");
    }
    if (!tk.index.built()) {
      return makeError("NOT_BUILT", "The search index has not been built.");
    }

    SearchStats stats;

    if (command == "SEARCH_APP") {
      std::vector<long long> matches = tk.index.findByApplicationPrefix(arguments[1], stats);
      return "{\"ok\":true," + formatSearchStats(stats) + ",\"matches\":" + formatIdList(matches) + "}";
    }
    if (command == "SEARCH_TOKEN") {
      long long studentId = 0;
      bool found = tk.index.findToken(arguments[1], studentId, stats);
      std::vector<long long> matches = found ? std::vector<long long>{studentId} : std::vector<long long>{};
      return "{\"ok\":true," + formatSearchStats(stats) + ",\"matches\":" + formatIdList(matches) + "}";
    }
    if (command == "SEARCH_NAME") {
      std::vector<long long> matches = tk.index.findByName(decodeSpaces(arguments[1]), stats);
      return "{\"ok\":true," + formatSearchStats(stats) + ",\"matches\":" + formatIdList(matches) + "}";
    }
  }

  return "";
}

// -----------------------------------------------------------------------------
// Subsystem 2: Sorting (Merge Sort Planner)
// -----------------------------------------------------------------------------

std::string handleSortCommand(Toolkit& tk, const std::vector<std::string>& arguments) {
  (void)tk;
  SortMode sortMode;
  if (arguments.size() < 3 || !parseSortMode(arguments[1], sortMode)) {
    return makeError("BAD_ARGUMENT",
                     "SORT <unscheduled|arrivals_time|arrivals_priority|arrivals_token> <n> items");
  }

  std::string errorMessage;
  std::vector<std::string> rawItems;
  if (!extractItems(arguments, 2, rawItems, errorMessage)) {
    return errorMessage;
  }

  std::vector<WorkItem> worklist;
  for (const std::string& itemStr : rawItems) {
    std::vector<std::string> fields = splitString(itemStr, ':');
    long long studentId = 0;
    long long priorityLevel = 0;
    long long minutesAfterMidnight = 0;
    long long tokenNumber = 0;
    long long waitKeyTimestamp = 0;

    if (fields.size() != 6 ||
        !parseLongLong(fields[0], studentId) ||
        !parseLongLong(fields[1], priorityLevel) ||
        !parseLongLong(fields[2], minutesAfterMidnight) ||
        !parseLongLong(fields[3], tokenNumber) ||
        !parseLongLong(fields[4], waitKeyTimestamp)) {
      return makeError("BAD_ARGUMENT", "SORT item: id:level:minutes:token:waitKey:name");
    }

    WorkItem item;
    item.id = studentId;
    item.level = static_cast<int>(priorityLevel);
    item.minutes = static_cast<int>(minutesAfterMidnight);
    item.token = static_cast<int>(tokenNumber);
    item.waitKey = waitKeyTimestamp;
    item.name = SearchIndex::lower(decodeSpaces(fields[5]));
    worklist.push_back(item);
  }

  std::size_t comparisons = sortWork(worklist, sortMode);

  std::vector<long long> sortedIds;
  for (const WorkItem& item : worklist) {
    sortedIds.push_back(item.id);
  }

  return "{\"ok\":true,\"algorithm\":\"merge sort\",\"comparisons\":" + std::to_string(comparisons) +
         ",\"size\":" + std::to_string(worklist.size()) +
         ",\"order\":" + formatIdList(sortedIds) + "}";
}

// -----------------------------------------------------------------------------
// Subsystem 3: Stack (Undo per Admin)
// -----------------------------------------------------------------------------

std::string handleStackCommand(Toolkit& tk, const std::string& command,
                               const std::vector<std::string>& arguments) {
  if (command == "STACK_PUSH") {
    long long adminId = 0;
    long long actionId = 0;
    long long studentId = 0;

    if (arguments.size() != 5 ||
        !parseLongLong(arguments[1], adminId) ||
        !parseLongLong(arguments[2], actionId) ||
        !parseLongLong(arguments[3], studentId) ||
        arguments[4].empty()) {
      return makeError("BAD_ARGUMENT", "STACK_PUSH <admin> <actionId> <studentId> <kind>");
    }

    UndoEntry newEntry;
    newEntry.actionId = actionId;
    newEntry.studentId = studentId;
    newEntry.kind = arguments[4];

    UndoEntry droppedEntry;
    bool hadDropped = tk.undo.push(adminId, newEntry, &droppedEntry);

    return "{\"ok\":true,\"size\":" + std::to_string(tk.undo.size(adminId)) +
           ",\"dropped\":" + std::to_string(hadDropped ? droppedEntry.actionId : 0) + "}";
  }

  if (command == "STACK_POP" || command == "STACK_PEEK" || command == "STACK_LIST") {
    long long adminId = 0;
    if (arguments.size() != 2 || !parseLongLong(arguments[1], adminId)) {
      return makeError("BAD_ARGUMENT", command + " <admin>");
    }

    if (command == "STACK_LIST") {
      std::vector<UndoEntry> entries = tk.undo.list(adminId);
      return "{\"ok\":true,\"size\":" + std::to_string(tk.undo.size(adminId)) +
             ",\"entries\":" + formatArray(entries, formatUndoEntry) + "}";
    }

    if (command == "STACK_PEEK") {
      const UndoEntry* top = tk.undo.peek(adminId);
      if (top == nullptr) {
        return makeError("EMPTY", "Nothing to undo.");
      }
      return "{\"ok\":true,\"size\":" + std::to_string(tk.undo.size(adminId)) +
             ",\"entry\":" + formatUndoEntry(*top) + "}";
    }

    // STACK_POP
    UndoEntry poppedEntry;
    if (!tk.undo.pop(adminId, poppedEntry)) {
      return makeError("EMPTY", "Nothing to undo.");
    }
    return "{\"ok\":true,\"size\":" + std::to_string(tk.undo.size(adminId)) +
           ",\"entry\":" + formatUndoEntry(poppedEntry) + "}";
  }

  if (command == "STACK_CLEAR_ALL") {
    tk.undo.clearAll();
    return "{\"ok\":true}";
  }

  return "";
}

// -----------------------------------------------------------------------------
// Subsystem 4: Sparse Matrix Report (Appointment Load)
// -----------------------------------------------------------------------------

std::string handleApptLoadCommand(Toolkit& tk, const std::vector<std::string>& arguments) {
  (void)tk;
  long long totalDays = 0;
  long long totalSlots = 0;
  long long fromSlot = 0;
  long long toSlot = 0;

  if (arguments.size() < 6 ||
      !parseLongLong(arguments[1], totalDays) ||
      !parseLongLong(arguments[2], totalSlots) ||
      !parseLongLong(arguments[3], fromSlot) ||
      !parseLongLong(arguments[4], toSlot) ||
      totalDays > 400 || totalSlots > 400) {
    return makeError("BAD_ARGUMENT", "APPT_LOAD <rows> <cols> <fromCol> <toCol> <n> day:slot ...");
  }

  std::string errorMessage;
  std::vector<std::string> rawItems;
  if (!extractItems(arguments, 5, rawItems, errorMessage)) {
    return errorMessage;
  }

  std::vector<std::pair<int, int>> bookings;
  for (const std::string& itemStr : rawItems) {
    std::vector<std::string> fields = splitString(itemStr, ':');
    long long day = 0;
    long long slot = 0;
    if (fields.size() != 2 || !parseLongLong(fields[0], day) || !parseLongLong(fields[1], slot)) {
      return makeError("BAD_ARGUMENT", "APPT_LOAD item: day:slot");
    }
    bookings.push_back({static_cast<int>(day), static_cast<int>(slot)});
  }

  LoadReport report;
  if (!computeAppointmentLoad(static_cast<int>(totalDays), static_cast<int>(totalSlots),
                              static_cast<int>(fromSlot), static_cast<int>(toSlot),
                              bookings, report)) {
    return makeError("BAD_ARGUMENT", "Booking outside the grid or bad range.");
  }

  auto formatCell = [](const LoadCell& cell) {
    return "[" + std::to_string(cell.row) + "," + std::to_string(cell.col) + "," +
           std::to_string(cell.count) + "]";
  };

  auto formatNumber = [](int value) {
    return std::to_string(value);
  };

  auto formatBestSlot = [](const BestSlot& best) {
    return "[" + std::to_string(best.col) + "," + std::to_string(best.count) + "]";
  };

  std::ostringstream jsonStream;
  jsonStream << "{\"ok\":true"
             << ",\"rows\":" << report.rows
             << ",\"cols\":" << report.cols
             << ",\"nonZeros\":" << report.nonZeros
             << ",\"density\":" << report.density
             << ",\"bookings\":" << bookings.size()
             << ",\"cells\":" << formatArray(report.cells, formatCell)
             << ",\"rowSums\":" << formatArray(report.rowSums, formatNumber)
             << ",\"colSums\":" << formatArray(report.colSums, formatNumber)
             << ",\"busiest\":" << formatArray(report.busiest, formatCell)
             << ",\"bestSlots\":" << formatArray(report.bestSlots, formatBestSlot)
             << ",\"lookupComparisons\":" << report.lookupComparisons
             << "}";

  return jsonStream.str();
}

// -----------------------------------------------------------------------------
// Subsystem 5: Dense Matrix Report (Document Readiness)
// -----------------------------------------------------------------------------

std::string handleDocReadinessCommand(Toolkit& tk, const std::vector<std::string>& arguments) {
  (void)tk;
  long long totalDocuments = 0;
  long long totalRounds = 0;

  if (arguments.size() < 3 ||
      !parseLongLong(arguments[1], totalDocuments) ||
      !parseLongLong(arguments[2], totalRounds) ||
      totalDocuments < 1 || totalRounds < 1 ||
      totalDocuments > 100 || totalRounds > 100) {
    return makeError("BAD_ARGUMENT",
                     "DOC_READINESS <docs> <rounds> <roundTotal...> <n> doc:round:count ...");
  }

  std::size_t countIndex = 3 + static_cast<std::size_t>(totalRounds);
  std::vector<int> roundTotals;

  for (long long r = 0; r < totalRounds; ++r) {
    long long roundTotal = 0;
    if (arguments.size() <= 3 + static_cast<std::size_t>(r) ||
        !parseLongLong(arguments[3 + static_cast<std::size_t>(r)], roundTotal) ||
        roundTotal < 0) {
      return makeError("BAD_ARGUMENT", "Bad round total.");
    }
    roundTotals.push_back(static_cast<int>(roundTotal));
  }

  std::string errorMessage;
  std::vector<std::string> rawItems;
  if (!extractItems(arguments, countIndex, rawItems, errorMessage)) {
    return errorMessage;
  }

  std::vector<DocCount> cellCounts;
  for (const std::string& itemStr : rawItems) {
    std::vector<std::string> fields = splitString(itemStr, ':');
    long long docId = 0;
    long long roundId = 0;
    long long count = 0;
    if (fields.size() != 3 ||
        !parseLongLong(fields[0], docId) ||
        !parseLongLong(fields[1], roundId) ||
        !parseLongLong(fields[2], count)) {
      return makeError("BAD_ARGUMENT", "DOC_READINESS item: doc:round:count");
    }
    cellCounts.push_back(DocCount{static_cast<int>(docId), static_cast<int>(roundId),
                                  static_cast<int>(count)});
  }

  ReadinessReport report;
  if (!computeDocReadiness(static_cast<int>(totalDocuments), static_cast<int>(totalRounds),
                           roundTotals, cellCounts, report)) {
    return makeError("BAD_ARGUMENT", "Invalid matrix data.");
  }

  auto formatNumber = [](int value) {
    return std::to_string(value);
  };

  auto formatPercent = [](double value) {
    char buffer[32];
    std::snprintf(buffer, sizeof(buffer), "%.1f", value);
    return std::string(buffer);
  };

  std::ostringstream jsonStream;
  jsonStream << "{\"ok\":true"
             << ",\"docs\":" << report.docs
             << ",\"rounds\":" << report.rounds
             << ",\"counts\":" << formatArray(report.counts, formatNumber)
             << ",\"percent\":" << formatArray(report.percent, formatPercent)
             << ",\"docTotals\":" << formatArray(report.docTotals, formatNumber)
             << ",\"roundTotals\":" << formatArray(report.roundTotals, formatNumber)
             << ",\"weakestDoc\":" << formatArray(report.weakestDoc, formatNumber)
             << ",\"strongestDoc\":" << formatArray(report.strongestDoc, formatNumber)
             << "}";

  return jsonStream.str();
}

// -----------------------------------------------------------------------------
// Subsystem 6: Admission Progress Queue (Max-Heap)
// -----------------------------------------------------------------------------

std::string handleProgressHeapCommands(Toolkit& tk, const std::string& command,
                                       const std::vector<std::string>& arguments) {
  if (command == "PROGRESS_CLEAR") {
    tk.progress.clear();
    return "{\"ok\":true}";
  }

  if (command == "PROGRESS_UPSERT") {
    long long studentId = 0;
    if (arguments.size() != 5 || !parseLongLong(arguments[1], studentId) || arguments[2].empty()) {
      return makeError("BAD_ARGUMENT", "PROGRESS_UPSERT <studentId> <token> <score> <enteredAt>");
    }

    double priorityScore = 0.0;
    if (!parseDouble(arguments[3], priorityScore)) {
      return makeError("BAD_ARGUMENT", "Invalid score value.");
    }

    tk.progress.upsert(studentId, arguments[2], priorityScore, decodeSpaces(arguments[4]));
    return "{\"ok\":true,\"studentId\":" + std::to_string(studentId) +
           ",\"size\":" + std::to_string(tk.progress.size()) + "}";
  }

  if (command == "PROGRESS_REMOVE") {
    long long studentId = 0;
    if (arguments.size() != 2 || !parseLongLong(arguments[1], studentId)) {
      return makeError("BAD_ARGUMENT", "PROGRESS_REMOVE <studentId>");
    }

    bool wasRemoved = tk.progress.remove(studentId);
    return "{\"ok\":true,\"studentId\":" + std::to_string(studentId) +
           ",\"removed\":" + (wasRemoved ? "true" : "false") +
           ",\"size\":" + std::to_string(tk.progress.size()) + "}";
  }

  if (command == "PROGRESS_LOAD") {
    std::string errorMessage;
    std::vector<std::string> rawItems;
    if (!extractItems(arguments, 1, rawItems, errorMessage)) {
      return errorMessage;
    }

    for (const std::string& itemStr : rawItems) {
      std::vector<std::string> fields = splitString(itemStr, '|');
      long long studentId = 0;
      if (fields.size() != 4 || !parseLongLong(fields[0], studentId) || fields[1].empty()) {
        return makeError("BAD_ARGUMENT", "PROGRESS_LOAD item: studentId|token|score|enteredAt");
      }

      double priorityScore = 0.0;
      if (!parseDouble(fields[2], priorityScore)) {
        return makeError("BAD_ARGUMENT", "Invalid score in PROGRESS_LOAD item.");
      }

      tk.progress.upsert(studentId, fields[1], priorityScore, decodeSpaces(fields[3]));
    }

    return "{\"ok\":true,\"loaded\":" + std::to_string(rawItems.size()) +
           ",\"size\":" + std::to_string(tk.progress.size()) + "}";
  }

  if (command == "PROGRESS_PEEK") {
    const ProgressStudent* topStudent = tk.progress.peek();
    if (topStudent == nullptr) {
      return "{\"ok\":true,\"hasStudent\":false}";
    }

    char scoreBuffer[32];
    std::snprintf(scoreBuffer, sizeof(scoreBuffer), "%.4f", topStudent->score);

    return "{\"ok\":true,\"hasStudent\":true,\"student\":{\"studentId\":" +
           std::to_string(topStudent->studentId) +
           ",\"token\":\"" + jsonEscape(topStudent->token) + "\"" +
           ",\"score\":" + scoreBuffer +
           ",\"enteredAt\":\"" + jsonEscape(topStudent->enteredAt) + "\"}}";
  }

  if (command == "PROGRESS_SIZE") {
    return "{\"ok\":true,\"size\":" + std::to_string(tk.progress.size()) + "}";
  }

  if (command == "PROGRESS_RANK") {
    std::vector<ProgressStudent> rankedStudents = tk.progress.getRanked();
    std::ostringstream jsonStream;
    jsonStream << "{\"ok\":true,\"size\":" << rankedStudents.size() << ",\"ranked\":[";

    for (std::size_t i = 0; i < rankedStudents.size(); ++i) {
      if (i > 0) {
        jsonStream << ",";
      }
      char scoreBuffer[32];
      std::snprintf(scoreBuffer, sizeof(scoreBuffer), "%.4f", rankedStudents[i].score);

      jsonStream << "{\"position\":" << (i + 1)
                 << ",\"studentId\":" << rankedStudents[i].studentId
                 << ",\"token\":\"" << jsonEscape(rankedStudents[i].token) << "\""
                 << ",\"score\":" << scoreBuffer
                 << ",\"enteredAt\":\"" << jsonEscape(rankedStudents[i].enteredAt) << "\"}";
    }

    jsonStream << "]}";
    return jsonStream.str();
  }

  return "";
}

}  // namespace

// Central Dispatcher: Routes incoming commands to respective subsystems
std::string handleToolkitLine(Toolkit& tk, const std::string& line, bool& quit) {
  std::istringstream stream(line);
  std::vector<std::string> arguments;
  for (std::string word; stream >> word;) {
    arguments.push_back(word);
  }

  if (arguments.empty()) {
    // Forward empty line to queue protocol handler
    return handleLine(tk.queue, line, quit);
  }

  const std::string& command = arguments[0];

  // 1. Search Index commands (INDEX_*, SEARCH_*)
  if (command == "INDEX_CLEAR" || command == "INDEX_ADD" ||
      command == "INDEX_TOKENS" || command == "INDEX_BUILD" ||
      command == "SEARCH_APP" || command == "SEARCH_TOKEN" || command == "SEARCH_NAME") {
    return handleSearchIndexCommands(tk, command, arguments);
  }

  // 2. Sorting command (SORT)
  if (command == "SORT") {
    return handleSortCommand(tk, arguments);
  }

  // 3. Stack commands (STACK_*)
  if (command == "STACK_PUSH" || command == "STACK_POP" ||
      command == "STACK_PEEK" || command == "STACK_LIST" ||
      command == "STACK_CLEAR_ALL") {
    return handleStackCommand(tk, command, arguments);
  }

  // 4. Matrix Reports commands (APPT_LOAD, DOC_READINESS)
  if (command == "APPT_LOAD") {
    return handleApptLoadCommand(tk, arguments);
  }
  if (command == "DOC_READINESS") {
    return handleDocReadinessCommand(tk, arguments);
  }

  // 5. Admission Progress Max-Heap commands (PROGRESS_*)
  if (command == "PROGRESS_CLEAR" || command == "PROGRESS_UPSERT" ||
      command == "PROGRESS_REMOVE" || command == "PROGRESS_LOAD" ||
      command == "PROGRESS_PEEK" || command == "PROGRESS_SIZE" ||
      command == "PROGRESS_RANK") {
    return handleProgressHeapCommands(tk, command, arguments);
  }

  // 6. Non-toolkit commands belong to the Phase 4 Queue Engine
  return handleLine(tk.queue, line, quit);
}

}  // namespace admitflow
