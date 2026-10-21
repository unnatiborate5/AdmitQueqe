// Text protocol spoken between the Node backend and the engine process (one request line -> one JSON line).
#ifndef ADMITFLOW_PROTOCOL_H
#define ADMITFLOW_PROTOCOL_H

#include <string>
#include "queue_engine.h"

namespace admitflow {

// Executes one request line against the engine and returns the single-line JSON reply.
std::string handleLine(QueueEngine& engine, const std::string& line, bool& quit);

std::string jsonEscape(const std::string& s);
std::string tokenJson(const TokenView& v);
std::string resultJson(const QueueEngine& engine, const Result& r);
std::string snapshotJson(const Snapshot& s);

}  // namespace admitflow

#endif

