// AdmitFlow Protocol Implementation
// Handles command line parsing and JSON formatting for the Queue Engine.

#include <iostream>
#include <string>
#include <vector>
#include <sstream>
#include <cstdlib>

#include "protocol.h"
#include "queue_engine.h"

using namespace std;

namespace admitflow {

namespace {

// Escapes special characters for JSON strings
string escapeJsonString(const string& input) {
  string escaped;
  for (char ch : input) {
    if (ch == '"' || ch == '\\') {
      escaped += '\\';
      escaped += ch;
    } else if (static_cast<unsigned char>(ch) < 0x20) {
      escaped += ' ';
    } else {
      escaped += ch;
    }
  }
  return escaped;
}

// Parses string into a signed 64-bit integer
bool parseInteger(const string& str, long long& result) {
  if (str.empty()) {
    return false;
  }
  char* endPointer = nullptr;
  long long value = strtoll(str.c_str(), &endPointer, 10);
  if (endPointer == str.c_str() || *endPointer != '\0') {
    return false;
  }
  result = value;
  return true;
}

// Builds standard error JSON response
string buildErrorJson(const string& errorCode, const string& errorMessage) {
  return "{\"ok\":false,\"error\":\"" + escapeJsonString(errorCode) +
         "\",\"message\":\"" + escapeJsonString(errorMessage) + "\"}";
}

// Parses token status text
bool parseTokenStatus(const string& statusStr, Status& outStatus) {
  if (statusStr == "waiting") {
    outStatus = Status::Waiting;
    return true;
  }
  if (statusStr == "called") {
    outStatus = Status::Called;
    return true;
  }
  if (statusStr == "serving") {
    outStatus = Status::Serving;
    return true;
  }
  return false;
}

}  // namespace

string jsonEscape(const string& str) {
  return escapeJsonString(str);
}

// Serializes a TokenView into JSON
string tokenJson(const TokenView& view) {
  const Token& token = view.token;
  ostringstream jsonStream;

  const char* statusText = view.finalStatus.empty()
                               ? QueueEngine::statusName(token.status)
                               : view.finalStatus.c_str();

  jsonStream << "{\"code\":\"" << escapeJsonString(token.code) << "\""
             << ",\"seq\":" << token.seq
             << ",\"lane\":\"" << QueueEngine::laneName(token.lane) << "\""
             << ",\"level\":" << token.level
             << ",\"status\":\"" << statusText << "\""
             << ",\"counterId\":" << token.counterId
             << ",\"studentId\":" << token.studentId
             << ",\"applicationId\":\"" << escapeJsonString(token.appId) << "\""
             << ",\"position\":" << view.position
             << ",\"ahead\":" << view.ahead
             << "}";

  return jsonStream.str();
}

// Serializes Result into JSON
string resultJson(const QueueEngine& engine, const Result& result) {
  if (!result.ok) {
    string errorResponse = "{\"ok\":false,\"error\":\"" + escapeJsonString(result.error) +
                           "\",\"message\":\"" + escapeJsonString(result.message) + "\"";
    if (result.hasToken) {
      errorResponse += ",\"token\":" + tokenJson(result.token);
    }
    errorResponse += "}";
    return errorResponse;
  }

  string successResponse = "{\"ok\":true";
  if (result.hasToken) {
    successResponse += ",\"token\":" + tokenJson(result.token);
  }

  successResponse += ",\"returned\":[";
  for (size_t i = 0; i < result.returned.size(); i++) {
    if (i > 0) {
      successResponse += ",";
    }
    successResponse += tokenJson(result.returned[i]);
  }
  successResponse += "],\"streak\":" + to_string(engine.streak()) + "}";

  return successResponse;
}

// Serializes Snapshot into JSON
string snapshotJson(const Snapshot& snap) {
  ostringstream jsonStream;

  jsonStream << "{\"ok\":true"
             << ",\"fairness\":" << snap.fairness
             << ",\"streak\":" << snap.streak
             << ",\"lastSeq\":" << snap.lastSeq
             << ",\"priorityWaiting\":" << snap.priorityWaiting
             << ",\"regularWaiting\":" << snap.regularWaiting
             << ",\"called\":" << snap.called
             << ",\"serving\":" << snap.serving
             << ",\"counters\":[";

  for (size_t i = 0; i < snap.counters.size(); i++) {
    const CounterView& counter = snap.counters[i];
    if (i > 0) {
      jsonStream << ",";
    }
    jsonStream << "{\"id\":" << counter.id
               << ",\"open\":" << (counter.open ? "true" : "false")
               << ",\"token\":" << (counter.hasToken ? tokenJson(counter.token) : "null")
               << "}";
  }

  jsonStream << "],\"waiting\":[";
  for (size_t i = 0; i < snap.waiting.size(); i++) {
    if (i > 0) {
      jsonStream << ",";
    }
    jsonStream << tokenJson(snap.waiting[i]);
  }
  jsonStream << "]}";

  return jsonStream.str();
}

// Handles one line of command input for QueueEngine
string handleLine(QueueEngine& engine, const string& rawLine, bool& quit) {
  istringstream stream(rawLine);
  vector<string> arguments;
  for (string word; stream >> word;) {
    arguments.push_back(word);
  }

  if (arguments.empty()) {
    return buildErrorJson("BAD_COMMAND", "Empty command.");
  }

  const string& command = arguments[0];

  if (command == "QUIT") {
    quit = true;
    return "{\"ok\":true}";
  }

  if (command == "RESET") {
    long long fairnessBurst = 0;
    if (arguments.size() != 2 || !parseInteger(arguments[1], fairnessBurst) ||
        fairnessBurst < 1 || fairnessBurst > 1000) {
      return buildErrorJson("BAD_ARGUMENT", "RESET <fairness 1-1000>");
    }
    engine.reset(static_cast<int>(fairnessBurst));
    return resultJson(engine, Result());
  }

  if (command == "COUNTER") {
    long long counterId = 0;
    long long openFlag = 0;
    if (arguments.size() != 3 || !parseInteger(arguments[1], counterId) ||
        !parseInteger(arguments[2], openFlag) || (openFlag != 0 && openFlag != 1)) {
      return buildErrorJson("BAD_ARGUMENT", "COUNTER <id> <0|1>");
    }
    return resultJson(engine, engine.setCounter(static_cast<int>(counterId), openFlag == 1));
  }

  if (command == "SEQ") {
    long long lastSequence = 0;
    if (arguments.size() != 2 || !parseInteger(arguments[1], lastSequence) || lastSequence < 0) {
      return buildErrorJson("BAD_ARGUMENT", "SEQ <n>");
    }
    engine.setLastSeq(static_cast<int>(lastSequence));
    return resultJson(engine, Result());
  }

  if (command == "STREAK") {
    long long priorityStreak = 0;
    if (arguments.size() != 2 || !parseInteger(arguments[1], priorityStreak) || priorityStreak < 0) {
      return buildErrorJson("BAD_ARGUMENT", "STREAK <n>");
    }
    engine.setStreak(static_cast<int>(priorityStreak));
    return resultJson(engine, Result());
  }

  if (command == "LOAD") {
    Token restoredToken;
    long long sequenceNumber = 0;
    long long priorityLevel = 0;
    long long counterId = 0;
    long long studentId = 0;

    if (arguments.size() != 7 ||
        !parseInteger(arguments[1], sequenceNumber) ||
        !parseInteger(arguments[2], priorityLevel) ||
        !parseTokenStatus(arguments[3], restoredToken.status) ||
        !parseInteger(arguments[4], counterId) ||
        !parseInteger(arguments[5], studentId)) {
      return buildErrorJson("BAD_ARGUMENT", "LOAD <seq> <level> <status> <counter> <studentId> <appId>");
    }

    restoredToken.seq = static_cast<int>(sequenceNumber);
    restoredToken.level = static_cast<int>(priorityLevel);
    restoredToken.counterId = static_cast<int>(counterId);
    restoredToken.studentId = studentId;
    restoredToken.appId = arguments[6];

    return resultJson(engine, engine.load(restoredToken));
  }

  if (command == "ENQUEUE") {
    long long priorityLevel = 0;
    long long studentId = 0;

    if (arguments.size() != 4 ||
        !parseInteger(arguments[1], priorityLevel) ||
        !parseInteger(arguments[2], studentId)) {
      return buildErrorJson("BAD_ARGUMENT", "ENQUEUE <level> <studentId> <appId>");
    }

    const string& applicationId = arguments[3];
    return resultJson(engine, engine.enqueue(static_cast<int>(priorityLevel), studentId, applicationId));
  }

  if (command == "CALL") {
    long long counterId = 0;
    if (arguments.size() != 2 || !parseInteger(arguments[1], counterId)) {
      return buildErrorJson("BAD_ARGUMENT", "CALL <counter>");
    }
    return resultJson(engine, engine.callNext(static_cast<int>(counterId)));
  }

  if (command == "START" || command == "COMPLETE" ||
      command == "NOSHOW" || command == "CANCEL" ||
      command == "FIND_TOKEN" || command == "FIND_APP") {
    if (arguments.size() != 2) {
      return buildErrorJson("BAD_ARGUMENT", command + " <value>");
    }

    const string& value = arguments[1];
    Result result;

    if (command == "START") {
      result = engine.start(value);
    } else if (command == "COMPLETE") {
      result = engine.complete(value);
    } else if (command == "NOSHOW") {
      result = engine.noShow(value);
    } else if (command == "CANCEL") {
      result = engine.cancel(value);
    } else if (command == "FIND_TOKEN") {
      result = engine.findByCode(value);
    } else {
      result = engine.findByApplication(value);
    }

    return resultJson(engine, result);
  }

  if (command == "SNAPSHOT") {
    return snapshotJson(engine.snapshot());
  }

  return buildErrorJson("BAD_COMMAND", "Unknown command: " + command);
}

}  // namespace admitflow
