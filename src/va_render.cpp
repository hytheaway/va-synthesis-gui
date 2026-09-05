#include "va/binaural/hrtf_renderer.hpp"
#include "va/core/engine.hpp"
#include "va/geometrical/brt_geometrical_solver.hpp"
#include "va/hybrid/hybrid_solver.hpp"
#include "va/wave/fdtd_solver.hpp"
#include "va/wave/pffdtd_backend.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace {

struct WavAudio {
    double sample_rate{};
    va::AudioBuffer mono;
};

template <class T>
T read_le(std::istream& stream) {
    std::array<unsigned char, sizeof(T)> bytes{};
    stream.read(reinterpret_cast<char*>(bytes.data()), bytes.size());
    if (!stream) throw std::runtime_error("truncated WAV file");
    using Unsigned = std::make_unsigned_t<T>;
    Unsigned value{};
    for (std::size_t i = 0; i < bytes.size(); ++i) {
        value |= static_cast<Unsigned>(bytes[i]) << (8U * i);
    }
    return static_cast<T>(value);
}

void write_u16(std::ostream& stream, std::uint16_t value) {
    const std::array<char, 2> bytes{static_cast<char>(value), static_cast<char>(value >> 8U)};
    stream.write(bytes.data(), bytes.size());
}

void write_u32(std::ostream& stream, std::uint32_t value) {
    const std::array<char, 4> bytes{static_cast<char>(value), static_cast<char>(value >> 8U),
                                    static_cast<char>(value >> 16U), static_cast<char>(value >> 24U)};
    stream.write(bytes.data(), bytes.size());
}

void write_pcm24(std::ostream& stream, std::int32_t value) {
    const auto bits = static_cast<std::uint32_t>(value);
    const std::array<char, 3> bytes{static_cast<char>(bits), static_cast<char>(bits >> 8U),
                                    static_cast<char>(bits >> 16U)};
    stream.write(bytes.data(), bytes.size());
}

WavAudio read_wav(const std::filesystem::path& path) {
    std::ifstream input(path, std::ios::binary);
    if (!input) throw std::runtime_error("could not open input WAV file");
    std::array<char, 4> id{};
    input.read(id.data(), 4);
    static_cast<void>(read_le<std::uint32_t>(input));
    std::array<char, 4> wave{};
    input.read(wave.data(), 4);
    if (id != std::array<char, 4>{'R','I','F','F'} ||
        wave != std::array<char, 4>{'W','A','V','E'}) {
        throw std::runtime_error("input must be a RIFF/WAVE file");
    }

    std::uint16_t format = 0, channels = 0, bits = 0, block_align = 0;
    std::uint32_t sample_rate = 0;
    std::vector<unsigned char> data;
    while (input && (!format || data.empty())) {
        input.read(id.data(), 4);
        if (!input) break;
        const auto size = read_le<std::uint32_t>(input);
        if (id == std::array<char, 4>{'f','m','t',' '}) {
            if (size < 16) throw std::runtime_error("invalid WAV format chunk");
            format = read_le<std::uint16_t>(input);
            channels = read_le<std::uint16_t>(input);
            sample_rate = read_le<std::uint32_t>(input);
            static_cast<void>(read_le<std::uint32_t>(input));
            block_align = read_le<std::uint16_t>(input);
            bits = read_le<std::uint16_t>(input);
            input.seekg(static_cast<std::streamoff>(size - 16), std::ios::cur);
        } else if (id == std::array<char, 4>{'d','a','t','a'}) {
            data.resize(size);
            input.read(reinterpret_cast<char*>(data.data()), size);
        } else {
            input.seekg(static_cast<std::streamoff>(size), std::ios::cur);
        }
        if (size & 1U) input.seekg(1, std::ios::cur);
    }
    if ((format != 1 && format != 3) || channels == 0 || sample_rate == 0 ||
        block_align == 0 || data.empty()) {
        throw std::runtime_error("unsupported or incomplete WAV file");
    }
    if (!((format == 1 && (bits == 16 || bits == 24 || bits == 32)) ||
          (format == 3 && bits == 32))) {
        throw std::runtime_error("WAV must be 16/24/32-bit PCM or 32-bit float");
    }

    const auto frames = data.size() / block_align;
    va::AudioBuffer mono(frames);
    const auto bytes_per_sample = bits / 8U;
    for (std::size_t frame = 0; frame < frames; ++frame) {
        double sum = 0.0;
        for (std::size_t channel = 0; channel < channels; ++channel) {
            const auto* p = data.data() + frame * block_align + channel * bytes_per_sample;
            double sample = 0.0;
            if (format == 3) {
                std::uint32_t raw = static_cast<std::uint32_t>(p[0]) |
                    (static_cast<std::uint32_t>(p[1]) << 8U) |
                    (static_cast<std::uint32_t>(p[2]) << 16U) |
                    (static_cast<std::uint32_t>(p[3]) << 24U);
                sample = std::bit_cast<float>(raw);
            } else if (bits == 16) {
                const auto raw = static_cast<std::int16_t>(
                    static_cast<std::uint16_t>(p[0]) | (static_cast<std::uint16_t>(p[1]) << 8U));
                sample = static_cast<double>(raw) / 32768.0;
            } else if (bits == 24) {
                std::int32_t raw = static_cast<std::int32_t>(p[0]) |
                    (static_cast<std::int32_t>(p[1]) << 8U) |
                    (static_cast<std::int32_t>(p[2]) << 16U);
                if (raw & 0x800000) raw |= ~0xffffff;
                sample = static_cast<double>(raw) / 8388608.0;
            } else {
                const auto raw = static_cast<std::int32_t>(
                    static_cast<std::uint32_t>(p[0]) | (static_cast<std::uint32_t>(p[1]) << 8U) |
                    (static_cast<std::uint32_t>(p[2]) << 16U) |
                    (static_cast<std::uint32_t>(p[3]) << 24U));
                sample = static_cast<double>(raw) / 2147483648.0;
            }
            sum += std::isfinite(sample) ? sample : 0.0;
        }
        mono[frame] = static_cast<float>(sum / channels);
    }
    return {static_cast<double>(sample_rate), std::move(mono)};
}

void write_wav(const std::filesystem::path& path, const std::vector<va::AudioBuffer>& channels,
               double sample_rate, bool normalize) {
    if (channels.empty() || channels.front().empty()) {
        throw std::runtime_error("rendered WAV has no samples");
    }
    const auto frames = channels.front().size();
    const auto channel_count = channels.size();
    for (const auto& channel : channels) {
        if (channel.size() != frames) throw std::runtime_error("stereo WAV channels must match");
    }
    if (channel_count > 2) throw std::runtime_error("WAV writer supports mono or stereo");
    if (frames > (std::numeric_limits<std::uint32_t>::max() - 44U) / (3U * channel_count)) {
        throw std::length_error("rendered WAV is too large");
    }
    double scale = 1.0;
    if (normalize) {
        double peak = 0.0;
        for (const auto& channel : channels) {
            for (const auto sample : channel) peak = std::max(peak, std::abs(static_cast<double>(sample)));
        }
        if (peak > 0.0) scale = 0.98 / peak;
    }
    std::ofstream output(path, std::ios::binary);
    if (!output) throw std::runtime_error("could not create output WAV file");
    const auto block_align = static_cast<std::uint16_t>(3U * channel_count);
    const auto data_size = static_cast<std::uint32_t>(frames * block_align);
    output.write("RIFF", 4); write_u32(output, 36U + data_size); output.write("WAVE", 4);
    output.write("fmt ", 4); write_u32(output, 16); write_u16(output, 1);
    write_u16(output, static_cast<std::uint16_t>(channel_count));
    const auto rate = static_cast<std::uint32_t>(std::llround(sample_rate));
    write_u32(output, rate); write_u32(output, rate * block_align); write_u16(output, block_align);
    write_u16(output, 24);
    output.write("data", 4); write_u32(output, data_size);
    for (std::size_t frame = 0; frame < frames; ++frame) {
        for (const auto& channel : channels) {
            const auto clipped = std::clamp(static_cast<double>(channel[frame]) * scale, -1.0, 1.0);
            const auto pcm = static_cast<std::int32_t>(std::llround(clipped * 8388607.0));
            write_pcm24(output, pcm);
        }
    }
}

using Args = std::unordered_map<std::string, std::string>;

Args parse_args(int argc, char** argv) {
    Args args;
    for (int i = 1; i < argc; i += 2) {
        if (i + 1 >= argc || !std::string_view(argv[i]).starts_with("--")) {
            throw std::invalid_argument("arguments must be --name value pairs");
        }
        args.emplace(std::string(argv[i]).substr(2), argv[i + 1]);
    }
    return args;
}

std::string get(const Args& args, const std::string& key, std::string fallback = {}) {
    const auto it = args.find(key);
    return it == args.end() ? fallback : it->second;
}

double number(const Args& args, const std::string& key, double fallback) {
    const auto value = get(args, key);
    if (value.empty()) return fallback;
    std::size_t used = 0;
    const auto result = std::stod(value, &used);
    if (used != value.size() || !std::isfinite(result)) throw std::invalid_argument("invalid --" + key);
    return result;
}

bool boolean(const Args& args, const std::string& key, bool fallback) {
    const auto value = get(args, key);
    if (value.empty()) return fallback;
    if (value == "true" || value == "1") return true;
    if (value == "false" || value == "0") return false;
    throw std::invalid_argument("invalid --" + key);
}

va::Vec3 vector3(const Args& args, std::string_view prefix, va::Vec3 fallback) {
    const auto p = std::string(prefix);
    return {number(args, p + "-x", fallback.x), number(args, p + "-y", fallback.y),
            number(args, p + "-z", fallback.z)};
}

std::unique_ptr<va::PropagationSolver> wave_solver(const Args& args) {
    if (get(args, "wave-backend", "reference") == "pffdtd") {
        va::wave::PFFDTDSettings settings;
        settings.repository = get(args, "pffdtd-repository", "submodules/va-synthesis/submodules/pffdtd");
        settings.data_directory = get(args, "pffdtd-data-directory");
        settings.bridge_script = get(args, "pffdtd-bridge", "submodules/va-synthesis/tools/pffdtd_bridge.py");
        settings.python_executable = get(args, "pffdtd-python", "python3");
        const auto execution = get(args, "pffdtd-execution", "prepared");
        if (execution == "python") settings.execution = va::wave::PFFDTDExecution::python_cpu;
        else if (execution == "native-double") settings.execution = va::wave::PFFDTDExecution::native_cpu_double;
        else if (execution == "native-single") settings.execution = va::wave::PFFDTDExecution::native_cpu_single;
        else settings.execution = va::wave::PFFDTDExecution::prepared_output;
        settings.valid_bandwidth = number(args, "maximum-frequency", 1000.0);
        settings.apply_air_absorption = boolean(args, "air-absorption", false);
        return std::make_unique<va::wave::PFFDTDBackend>(std::move(settings));
    }
    va::wave::FDTDSettings settings;
    settings.maximum_frequency = number(args, "maximum-frequency", 800.0);
    settings.points_per_wavelength = number(args, "points-per-wavelength", 6.0);
    settings.courant_safety_factor = number(args, "courant", 0.999);
    settings.boundary_absorption = number(args, "boundary-absorption", 0.2);
    return std::make_unique<va::wave::FDTDSolver>(settings);
}

std::unique_ptr<va::PropagationSolver> geometrical_solver(const Args& args) {
    va::geometrical::BRTSettings settings;
    const auto method = get(args, "geometrical-method", "auto");
    if (method == "image-source") settings.method = va::geometrical::Method::image_source;
    else if (method == "sdn") settings.method = va::geometrical::Method::scattering_delay_network;
    else if (method == "free-field") settings.method = va::geometrical::Method::free_field;
    else if (method == "ray-tracing") settings.method = va::geometrical::Method::ray_tracing;
    else if (method == "auto") settings.method =
        va::geometrical::BRTGeometricalSolver::brt_headers_available()
            ? va::geometrical::Method::scattering_delay_network
            : va::geometrical::Method::ray_tracing;
    else throw std::invalid_argument("--geometrical-method must be auto, ray-tracing, image-source, sdn, or free-field");
    settings.reflection_order = static_cast<std::size_t>(number(args, "reflection-order", 2));
    settings.propagation_delay = boolean(args, "propagation-delay", true);
    settings.distance_attenuation = boolean(args, "distance-attenuation", true);
    settings.enable_direct_path = boolean(args, "direct-path", true);
    settings.enable_reverberation = boolean(args, "reverberation", true);
    settings.default_absorption = number(args, "wall-absorption", 0.2);
    settings.ray_count = static_cast<std::size_t>(number(args, "ray-count", 32768));
    settings.receiver_radius = number(args, "receiver-radius", 0.2);
    return std::make_unique<va::geometrical::BRTGeometricalSolver>(settings);
}

void add_shoebox_geometry(va::Scene& scene, double absorption) {
    const auto& low = scene.bounds.minimum;
    const auto& high = scene.bounds.maximum;
    const auto add = [&scene](va::Vec3 a, va::Vec3 b, va::Vec3 c) {
        scene.geometry.push_back({{{a, b, c}}, "room", 1});
    };
    add({low.x, low.y, low.z}, {low.x, high.y, low.z}, {high.x, high.y, low.z});
    add({low.x, low.y, low.z}, {high.x, high.y, low.z}, {high.x, low.y, low.z});
    add({low.x, low.y, high.z}, {high.x, high.y, high.z}, {low.x, high.y, high.z});
    add({low.x, low.y, high.z}, {high.x, low.y, high.z}, {high.x, high.y, high.z});
    add({low.x, low.y, low.z}, {high.x, low.y, high.z}, {low.x, low.y, high.z});
    add({low.x, low.y, low.z}, {high.x, low.y, low.z}, {high.x, low.y, high.z});
    add({low.x, high.y, low.z}, {low.x, high.y, high.z}, {high.x, high.y, high.z});
    add({low.x, high.y, low.z}, {high.x, high.y, high.z}, {high.x, high.y, low.z});
    add({low.x, low.y, low.z}, {low.x, low.y, high.z}, {low.x, high.y, high.z});
    add({low.x, low.y, low.z}, {low.x, high.y, high.z}, {low.x, high.y, low.z});
    add({high.x, low.y, low.z}, {high.x, high.y, high.z}, {high.x, low.y, high.z});
    add({high.x, low.y, low.z}, {high.x, high.y, low.z}, {high.x, high.y, high.z});
    va::AcousticMaterial room;
    room.id = "room";
    room.octave_absorption.fill(absorption);
    scene.materials.push_back(room);
}

bool brt_room_self_check(va::geometrical::Method method) {
    if (!va::geometrical::BRTGeometricalSolver::brt_headers_available()) return false;
    try {
        va::Scene scene;
        scene.bounds = {{0.0, 0.0, 0.0}, {4.0, 3.0, 2.5}};
        scene.sources.push_back({{1.0, 1.5, 1.25}, 1.0});
        scene.receivers.push_back({{3.0, 1.5, 1.25}});
        add_shoebox_geometry(scene, 0.2);
        va::geometrical::BRTSettings settings;
        settings.method = method;
        settings.reflection_order = 1;
        va::geometrical::BRTGeometricalSolver solver(settings);
        const auto responses = solver.compute_impulse_responses(scene, {48'000.0, 0.08});
        return std::count_if(responses.response(0, 0).begin(), responses.response(0, 0).end(),
            [](float sample) { return std::abs(sample) > 1.0e-8F; }) > 2;
    } catch (...) {
        return false;
    }
}

} // namespace

int main(int argc, char** argv) {
    try {
        const auto args = parse_args(argc, argv);
        if (boolean(args, "capabilities", false)) {
            const auto brt = va::geometrical::BRTGeometricalSolver::brt_headers_available();
            const auto brt_image_source = brt_room_self_check(va::geometrical::Method::image_source);
            const auto brt_sdn = brt_room_self_check(va::geometrical::Method::scattering_delay_network);
            const auto pffdtd = va::wave::PFFDTDBackend::submodule_available();
            std::cout
                << "{\"ready\":true,\"components\":["
                << "{\"name\":\"Core renderer\",\"status\":\"ready\","
                   "\"detail\":\"Audio rendering and convolution are operational\"},"
                << "{\"name\":\"Minimal FDTD\",\"status\":\"ready\","
                   "\"detail\":\"Built-in Cartesian wave solver is operational\"},"
                << "{\"name\":\"Geometrical solver\",\"status\":\"ready\","
                   "\"detail\":\"Shoebox geometry with BRT SDN or specular ray-traced reflections is operational\"},"
                << "{\"name\":\"BRTLibrary\",\"status\":\""
                << (!brt ? "unavailable" : (brt_image_source && brt_sdn ? "ready" : "limited"))
                << "\",\"detail\":\""
                << (!brt ? "Nested submodule was not present when this renderer was built"
                         : brt_image_source && brt_sdn ? "Linked; image-source and SDN self-checks passed"
                         : brt_sdn ? "Linked; SDN self-check passed, but image-source reflections failed self-check"
                         : "Linked, but BRT room-model self-checks failed")
                << "\"},"
                << "{\"name\":\"PFFDTD adapter\",\"status\":\""
                << (pffdtd ? "built" : "unavailable") << "\",\"detail\":\""
                << (pffdtd ? "Adapter is built; Python environment and prepared job are checked at render time"
                           : "Nested submodule was not present when this renderer was built")
                << "\"},"
                << "{\"name\":\"Binaural\",\"status\":\""
                << (va::binaural::sofa_reader_available() ? "ready" : "unavailable")
                << "\",\"detail\":\""
                << (va::binaural::sofa_reader_available()
                        ? "HRTF convolution is applied after the room renderer if SOFA file is provided"
                        : "libmysofa was not present when this renderer was built")
                << "\"},"
                << "{\"name\":\"Hybrid solver\",\"status\":\"ready\","
                   "\"detail\":\"Operational\"}]}\n";
            return 0;
        }
        const auto input_path = get(args, "input");
        const auto output_path = get(args, "output");
        if (input_path.empty() || output_path.empty()) {
            throw std::invalid_argument("--input and --output are required");
        }
        auto audio = read_wav(input_path);
        va::Scene scene;
        scene.bounds = {{0.0, 0.0, 0.0}, vector3(args, "room", {5.0, 4.0, 3.0})};
        scene.speed_of_sound = number(args, "speed-of-sound", 343.0);
        scene.sources.push_back({vector3(args, "source", {1.2, 1.5, 1.4}),
                                 number(args, "source-gain", 1.0)});
        scene.receivers.push_back({vector3(args, "receiver", {3.8, 2.5, 1.4}),
                                   number(args, "receiver-yaw", 0.0),
                                   number(args, "receiver-pitch", 0.0),
                                   number(args, "receiver-roll", 0.0)});
        add_shoebox_geometry(scene, number(args, "wall-absorption", 0.2));

        const auto mode = get(args, "mode", "geometrical");
        std::unique_ptr<va::PropagationSolver> solver;
        if (mode == "geometrical") {
            solver = geometrical_solver(args);
        } else if (mode == "wave") {
            solver = wave_solver(args);
        } else if (mode == "hybrid") {
            solver = std::make_unique<va::hybrid::HybridSolver>(
                wave_solver(args), geometrical_solver(args),
                va::hybrid::HybridSettings{number(args, "crossover", 500.0)});
        } else {
            throw std::invalid_argument("--mode must be geometrical, wave, or hybrid");
        }

        const auto output_rate = number(args, "output-rate", audio.sample_rate);
        va::Engine engine(std::move(solver));
        const va::AudioProgram program{audio.sample_rate, {std::move(audio.mono)}};
        const va::ImpulseResponseSettings impulse{output_rate, number(args, "ir-duration", 0.6)};
        const va::RenderSettings rendering{output_rate, boolean(args, "reverb-tail", true)};
        const auto result = engine.render(scene, program, impulse, rendering);
        if (result.receiver_signals.empty()) throw std::runtime_error("solver produced no receiver audio");
        const auto sofa_path = get(args, "hrtf-sofa");
        std::vector<va::AudioBuffer> output_channels;
        if (sofa_path.empty()) {
            output_channels.push_back(result.receiver_signals.front());
        } else {
            const auto stereo = va::binaural::spatialize_receiver(
                result.receiver_signals.front(), result.sample_rate, sofa_path,
                scene.sources.front().position, scene.receivers.front());
            output_channels.push_back(std::move(stereo.left));
            output_channels.push_back(std::move(stereo.right));
        }
        write_wav(output_path, output_channels, result.sample_rate, boolean(args, "normalize", true));
        std::cout << "Rendered " << output_channels.front().size() << " "
                  << (output_channels.size() == 2 ? "stereo" : "mono") << " samples with "
                  << engine.solver().name() << "\n";
    } catch (const std::exception& error) {
        std::cerr << "error: " << error.what() << '\n';
        return 1;
    }
}
