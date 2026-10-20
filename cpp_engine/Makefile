# Optional convenience wrapper. `npm start` / `npm test` build the engine automatically
# (backend/scripts/buildEngine.js), so you only need this if you want to build by hand.
CXX      ?= g++
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra -Wpedantic -Iinclude
SRC      := $(filter-out src/main.cpp,$(wildcard src/*.cpp))
BUILD    := build

all: $(BUILD)/queue_engine

HEADERS  := $(wildcard include/*.hpp include/dsa/*.hpp include/algo/*.hpp)

$(BUILD)/queue_engine: $(SRC) src/main.cpp $(HEADERS)
	@mkdir -p $(BUILD)
	$(CXX) $(CXXFLAGS) $(SRC) src/main.cpp -o $@

$(BUILD)/test_%: $(SRC) tests/test_%.cpp $(HEADERS)
	@mkdir -p $(BUILD)
	$(CXX) $(CXXFLAGS) $(SRC) tests/test_$*.cpp -o $@

test: $(BUILD)/test_engine $(BUILD)/test_toolkit
	./$(BUILD)/test_engine
	./$(BUILD)/test_toolkit

clean:
	rm -f $(BUILD)/queue_engine $(BUILD)/test_engine $(BUILD)/test_toolkit

.PHONY: all test clean
