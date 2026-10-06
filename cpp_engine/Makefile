# Optional convenience wrapper. `npm start` / `npm test` build the engine automatically
# (backend/scripts/buildEngine.js), so you only need this if you want to build by hand.
CXX      ?= g++
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra -Wpedantic -Iinclude
SRC      := src/queue_engine.cpp src/protocol.cpp
BUILD    := build

all: $(BUILD)/queue_engine

$(BUILD)/queue_engine: $(SRC) src/main.cpp $(wildcard include/*.hpp include/dsa/*.hpp)
	@mkdir -p $(BUILD)
	$(CXX) $(CXXFLAGS) $(SRC) src/main.cpp -o $@

$(BUILD)/test_engine: $(SRC) tests/test_engine.cpp $(wildcard include/*.hpp include/dsa/*.hpp)
	@mkdir -p $(BUILD)
	$(CXX) $(CXXFLAGS) $(SRC) tests/test_engine.cpp -o $@

test: $(BUILD)/test_engine
	./$(BUILD)/test_engine

clean:
	rm -f $(BUILD)/queue_engine $(BUILD)/test_engine

.PHONY: all test clean
