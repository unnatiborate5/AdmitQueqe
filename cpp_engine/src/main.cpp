// AdmitFlow Queue Engine - Main Entry Point
// Long-running C++ process communicating with Node.js backend over stdin/stdout.

#include <iostream>
#include <string>
#include <vector>
#include <algorithm>
#include <cstdlib>

#include "toolkit.h"
#include "protocol.h"
#include "queue_engine.h"

using namespace std;
using namespace admitflow;

int main(int argc, char** argv) {
  // Speed up standard I/O for inter-process communication
  ios::sync_with_stdio(false);

  // Read fairness burst from command line argument (default is 3)
  int fairnessBurst = 3;
  if (argc > 1) {
    fairnessBurst = atoi(argv[1]);
  }

  // Initialize the complete AdmitFlow Toolkit
  Toolkit toolkit(fairnessBurst);

  string line;
  bool quit = false;

  // Read command line by line from standard input
  while (!quit && getline(cin, line)) {
    // Remove Windows trailing carriage return if present
    if (!line.empty() && line.back() == '\r') {
      line.pop_back();
    }

    // Process command and print JSON reply followed by newline and flush
    string response = handleToolkitLine(toolkit, line, quit);
    cout << response << "\n" << flush;
  }

  return 0;
}
