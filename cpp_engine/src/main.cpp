// queue_engine: long-running process started by the Node backend. Reads one request per line on stdin,
// writes one JSON reply per line on stdout. Queue commands: include/protocol.hpp. Phase 5 commands: include/toolkit.hpp.
#include <cstdlib>
#include <iostream>
#include <string>

#include "protocol.hpp"
#include "queue_engine.hpp"
#include "toolkit.hpp"

int main(int argc, char** argv) {
  std::ios::sync_with_stdio(false);
  int fairness = 3;
  if (argc > 1) fairness = std::atoi(argv[1]);
  admitflow::Toolkit toolkit(fairness);   // Phase 4 queue engine + Phase 5 search / sort / stack / matrices

  std::string line;
  bool quit = false;
  while (!quit && std::getline(std::cin, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    std::cout << admitflow::handleToolkitLine(toolkit, line, quit) << '\n' << std::flush;
  }
  return 0;
}
