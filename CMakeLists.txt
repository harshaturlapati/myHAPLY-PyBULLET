cmake_minimum_required(VERSION 3.18)   # 3.18 = Raspberry Pi OS 11 (Bullseye) apt package

# Optional: Haply's closed-source legacy HardwareAPI (downloaded from Haply). The examples do NOT need it:
# libs/myHAPLY_v1.h talks to the Inverse3 directly. Kept for reference / comparison only.
option(MYHAPLY_WITH_HARDWAREAPI "Also fetch Haply's legacy HardwareAPI 0.2.8 (target Haply::HardwareAPI)" OFF)

if(POLICY CMP0091)
  cmake_policy(SET CMP0091 NEW)
endif()
if(MYHAPLY_WITH_HARDWAREAPI)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreadedDLL")   # Haply's Windows .lib is /MD release
endif()

PROJECT(myHAPLY_PyBULLET CXX)

# Same layout as myVIRTUOSE-PyBULLET:
#   src/   -> Bullet shared-memory client (library "pybullet_cpp"), talks to `python -m pybullet_utils.runServer`
#   libs/  -> header-only helpers (Haply device, serial port, logging, timing, Eigen, geometry)
#   [0-9]*-*/[0-9]*.cpp -> one executable per example, e.g. 100-Haply-basics/01_read_fbk.cpp
# Builds unchanged on Windows (MSVC), Linux / Raspberry Pi OS (GCC) and macOS (Clang).

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

if(MSVC)
  add_compile_options(/utf-8 /bigobj)
  add_compile_definitions(_CRT_SECURE_NO_WARNINGS NOMINMAX WIN32_LEAN_AND_MEAN)
endif()

find_package(Threads REQUIRED)
if(MYHAPLY_WITH_HARDWAREAPI)
  include(${PROJECT_SOURCE_DIR}/cmake/HaplyHardwareAPI.cmake)
endif()

add_subdirectory(src)

include_directories("${PROJECT_SOURCE_DIR}/libs")
include_directories("${PROJECT_SOURCE_DIR}/libs/Eigen")
include_directories("${PROJECT_SOURCE_DIR}/libs/myGEOMETRY")
include_directories("${PROJECT_SOURCE_DIR}/src")

# Create executable for each example
# Look for examples under folders
file(GLOB EXE_LIST RELATIVE ${PROJECT_SOURCE_DIR} CONFIGURE_DEPENDS "[0-9]*-*/[0-9]*.cpp")
foreach(SRC_FILE ${EXE_LIST})

  string(REPLACE ".cpp" "" TARGET_EXE_NAME ${SRC_FILE})
  string(REPLACE "/" "_" TARGET_EXE_NAME ${TARGET_EXE_NAME})

  message(STATUS "creating TARGET_EXE_NAME: '${TARGET_EXE_NAME}'")

  add_executable(${TARGET_EXE_NAME} ${SRC_FILE})
  target_link_libraries(${TARGET_EXE_NAME} PUBLIC pybullet_cpp Threads::Threads)
  if(WIN32)
    target_link_libraries(${TARGET_EXE_NAME} PUBLIC winmm ws2_32 setupapi advapi32)
  endif()
  if(MSVC)
    target_compile_options(${TARGET_EXE_NAME} PRIVATE /W3)
  else()
    target_compile_options(${TARGET_EXE_NAME} PRIVATE -Wall)
  endif()

endforeach()
