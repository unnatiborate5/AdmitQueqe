// Text protocol spoken between the Node backend and the engine process (one request line -> one JSON line).
//
//   RESET <fairness>                           forget everything and set the priority-burst limit
//   COUNTER <id> <0|1>                         create / open (1) / close (0) a counter
//   LOAD <seq> <level> <status> <counter> <studentId> <appId>   restore one active token
//   SEQ <n>   |  STREAK <n>                    restore the arrival counter / fairness streak
//   ENQUEUE <level> <studentId> <appId>        issue a token and queue the student
//   CALL <counter>                             call the next student to a counter
//   START|COMPLETE|NOSHOW|CANCEL <code>        token state changes
//   FIND_TOKEN <code> | FIND_APP <appId>       hash-map lookups
//   SNAPSHOT                                   whole engine state, waiting list in call order
//   QUIT
#ifndef ADMITFLOW_PROTOCOL_HPP
#define ADMITFLOW_PROTOCOL_HPP

#include <string>

#include "queue_engine.hpp"

namespace admitflow {

// Executes one request line against the engine and returns the single-line JSON reply.
std::string handleLine(QueueEngine& engine, const std::string& line, bool& quit);

std::string tokenJson(const TokenView& v);
std::string resultJson(const QueueEngine& engine, const Result& r);
std::string snapshotJson(const Snapshot& s);

}  // namespace admitflow

#endif
