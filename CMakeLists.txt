cmake_minimum_required(VERSION 3.22)

project(va_synthesis_gui VERSION 0.1.0 LANGUAGES CXX)

# The upstream integrations are optional.  The adapters and reference solvers
# still compile when their nested submodules have not been initialized.
set(VA_BUILD_APPS OFF CACHE BOOL "" FORCE)
set(VA_BUILD_TESTS OFF CACHE BOOL "" FORCE)

if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/submodules/va-synthesis/submodules/BRTLibrary/include/BRTLibrary.h")
    set(VA_ENABLE_BRT ON CACHE BOOL "" FORCE)
else()
    set(VA_ENABLE_BRT OFF CACHE BOOL "" FORCE)
endif()

if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/submodules/va-synthesis/submodules/pffdtd/python/fdtd/sim_fdtd.py")
    set(VA_ENABLE_PFFDTD ON CACHE BOOL "" FORCE)
else()
    set(VA_ENABLE_PFFDTD OFF CACHE BOOL "" FORCE)
endif()

add_subdirectory(submodules/va-synthesis)

add_executable(va_render src/va_render.cpp)
target_compile_features(va_render PRIVATE cxx_std_20)
target_link_libraries(va_render PRIVATE va::synthesis)

if(MSVC)
    target_compile_options(va_render PRIVATE /W4 /permissive-)
else()
    target_compile_options(va_render PRIVATE -Wall -Wextra -Wpedantic)
endif()

