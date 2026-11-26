# HaplyHardwareAPI.cmake - provides the imported target  Haply::HardwareAPI
#
# Haply's HardwareAPI is a closed-source static C++ library ("All rights reserved", Haply Robotics),
# so it is NOT stored in this repository. At configure time CMake downloads the archive for your
# platform from Haply's own release server (https://develop.haply.co/releases/cpp) and checks it.
#
#   Windows x64 ............ HardwareAPI.<ver>.win32.zip              (x64, /MD release runtime)
#   Raspberry Pi / aarch64 . HardwareAPI.<ver>.linux.gcc10.aarch64.tar.gz
#   Linux x86_64 ........... HardwareAPI.<ver>.linux.tar.gz
#   macOS .................. HardwareAPI.<ver>.macos.tar.gz
#
# Offline / lab machines: download the archive yourself, extract it, and configure with
#   cmake -B build -DHAPLY_HWAPI_DIR=/path/to/extracted/folder

set(HAPLY_HWAPI_VERSION "0.2.8" CACHE STRING "Haply HardwareAPI version to download")
set(HAPLY_HWAPI_DIR "" CACHE PATH "Folder holding an extracted HardwareAPI (headers + library). Empty = download.")
set(_haply_base_url "https://cdn.haply.co/r/33857671")

if(WIN32)
  set(_haply_archive "HardwareAPI.${HAPLY_HWAPI_VERSION}.win32.zip")
  set(_haply_sha256 "7b922cbab4bf95303abcddf05720a4bf8330f5e998b9b00c6815b301aba13195")
elseif(APPLE)
  set(_haply_archive "HardwareAPI.${HAPLY_HWAPI_VERSION}.macos.tar.gz")
  set(_haply_sha256 "")
elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "^(aarch64|arm64|ARM64)$")
  set(_haply_archive "HardwareAPI.${HAPLY_HWAPI_VERSION}.linux.gcc10.aarch64.tar.gz")
  set(_haply_sha256 "889b08053e214c8ec41ee62e3ebd1ffc541f30bb29cc516715ed0f29c6a225a7")
else()
  set(_haply_archive "HardwareAPI.${HAPLY_HWAPI_VERSION}.linux.tar.gz")
  set(_haply_sha256 "")
endif()
if(NOT HAPLY_HWAPI_VERSION STREQUAL "0.2.8")
  set(_haply_sha256 "")   # hashes above are for 0.2.8 only
endif()

if(NOT HAPLY_HWAPI_DIR)
  set(_haply_dl_dir "${CMAKE_BINARY_DIR}/_deps/haply_hwapi")
  set(_haply_file "${_haply_dl_dir}/${_haply_archive}")
  set(HAPLY_HWAPI_DIR "${_haply_dl_dir}/extracted")
  if(NOT EXISTS "${HAPLY_HWAPI_DIR}/.done")
    message(STATUS "Downloading Haply HardwareAPI: ${_haply_base_url}/${_haply_archive}")
    if(_haply_sha256)
      file(DOWNLOAD "${_haply_base_url}/${_haply_archive}" "${_haply_file}"
           EXPECTED_HASH SHA256=${_haply_sha256} STATUS _st TLS_VERIFY ON)
    else()
      file(DOWNLOAD "${_haply_base_url}/${_haply_archive}" "${_haply_file}" STATUS _st TLS_VERIFY ON)
    endif()
    list(GET _st 0 _code)
    if(NOT _code EQUAL 0)
      list(GET _st 1 _msg)
      message(FATAL_ERROR "Could not download the Haply HardwareAPI (${_msg}).\n"
              "Download ${_haply_archive} from https://develop.haply.co/releases/cpp, extract it and "
              "re-run CMake with -DHAPLY_HWAPI_DIR=<folder>.")
    endif()
    file(REMOVE_RECURSE "${HAPLY_HWAPI_DIR}")
    file(ARCHIVE_EXTRACT INPUT "${_haply_file}" DESTINATION "${HAPLY_HWAPI_DIR}")
    file(WRITE "${HAPLY_HWAPI_DIR}/.done" "${_haply_archive}\n")
  endif()
endif()

# The Windows zip is flat; the Linux/macOS archives have include/ + the .a at the top level.
unset(HAPLY_HWAPI_INCLUDE_DIR CACHE)
unset(HAPLY_HWAPI_LIBRARY CACHE)
find_path(HAPLY_HWAPI_INCLUDE_DIR HardwareAPI.h
          PATHS "${HAPLY_HWAPI_DIR}" "${HAPLY_HWAPI_DIR}/include" NO_DEFAULT_PATH)
find_library(HAPLY_HWAPI_LIBRARY NAMES Haply.HardwareAPI
             PATHS "${HAPLY_HWAPI_DIR}" "${HAPLY_HWAPI_DIR}/lib" NO_DEFAULT_PATH)
if(NOT HAPLY_HWAPI_INCLUDE_DIR OR NOT HAPLY_HWAPI_LIBRARY)
  message(FATAL_ERROR "Haply HardwareAPI not found in ${HAPLY_HWAPI_DIR} (need HardwareAPI.h and the Haply.HardwareAPI library).")
endif()
message(STATUS "Haply HardwareAPI ${HAPLY_HWAPI_VERSION}: ${HAPLY_HWAPI_LIBRARY}")

add_library(Haply::HardwareAPI STATIC IMPORTED GLOBAL)
set_target_properties(Haply::HardwareAPI PROPERTIES
  IMPORTED_LOCATION "${HAPLY_HWAPI_LIBRARY}"
  INTERFACE_INCLUDE_DIRECTORIES "${HAPLY_HWAPI_INCLUDE_DIR}")
if(WIN32)
  set_property(TARGET Haply::HardwareAPI APPEND PROPERTY INTERFACE_LINK_LIBRARIES setupapi cfgmgr32 advapi32)
else()
  # Haply's Linux archives are built with GCC 12; on older systems (Raspberry Pi OS 11: glibc 2.31, GCC 10)
  # this tiny library supplies the few runtime symbols they expect. It is empty on newer systems.
  add_library(haply_compat STATIC "${CMAKE_CURRENT_LIST_DIR}/../libs/compat/haply_libstdcxx_compat.cpp")
  set_property(TARGET Haply::HardwareAPI APPEND PROPERTY INTERFACE_LINK_LIBRARIES
               haply_compat Threads::Threads ${CMAKE_DL_LIBS})
endif()
