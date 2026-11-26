# Bullet shared-memory client (from erwincoumans/pybullet_cpp_sharedmemory_example, via myVIRTUOSE-PyBULLET).
# Lets a C++ program drive a PyBullet server started with:  python -m pybullet_utils.runServer
file(GLOB_RECURSE pybullet_cpp_SRC CONFIGURE_DEPENDS "*.h" "*.cpp")

add_library(pybullet_cpp STATIC ${pybullet_cpp_SRC})
target_include_directories(pybullet_cpp PUBLIC .)
target_compile_definitions(pybullet_cpp PUBLIC BT_USE_DOUBLE_PRECISION)
target_link_libraries(pybullet_cpp PUBLIC Threads::Threads)
if(MSVC)
  target_compile_options(pybullet_cpp PRIVATE /W0)
else()
  target_compile_options(pybullet_cpp PRIVATE -w)
endif()
