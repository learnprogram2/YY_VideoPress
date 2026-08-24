package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// VideoService is the Go backend bound to the React frontend. It wraps
// ffmpeg/ffprobe to probe and produce videos locally.
type VideoService struct{}

// VideoInfo is the metadata shown for the selected file.
type VideoInfo struct {
	Path      string  `json:"path"`
	Name      string  `json:"name"`
	SizeBytes int64   `json:"sizeBytes"`
	Width     int     `json:"width"`
	Height    int     `json:"height"`
	Duration  float64 `json:"duration"`
	Codec     string  `json:"codec"`
	Container string  `json:"container"`
}

// ConvertResult is returned after a produce operation.
type ConvertResult struct {
	OutputPath      string `json:"outputPath"`
	OutputName      string `json:"outputName"`
	InputSizeBytes  int64  `json:"inputSizeBytes"`
	OutputSizeBytes int64  `json:"outputSizeBytes"`
}

const audioKbps = 128

func bin(name string) (string, error) {
	if p, err := exec.LookPath(name); err == nil {
		return p, nil
	}
	fallback := "/opt/homebrew/bin/" + name
	if _, err := os.Stat(fallback); err == nil {
		return fallback, nil
	}
	return "", fmt.Errorf("%s not found — install it with `brew install ffmpeg`", name)
}

// PickFile opens a native file picker and returns the chosen path.
func (s *VideoService) PickFile() (string, error) {
	return application.Get().Dialog.OpenFile().
		CanChooseFiles(true).
		CanChooseDirectories(false).
		SetTitle("Choose a video").
		PromptForSingleSelection()
}

// PickFolder opens a native folder picker for the output directory.
func (s *VideoService) PickFolder() (string, error) {
	return application.Get().Dialog.OpenFile().
		CanChooseDirectories(true).
		CanChooseFiles(false).
		SetTitle("Choose output folder").
		PromptForSingleSelection()
}

// Probe returns metadata for the file at path.
func (s *VideoService) Probe(path string) (VideoInfo, error) {
	info := VideoInfo{Path: path, Name: filepath.Base(path)}
	st, err := os.Stat(path)
	if err != nil {
		return info, err
	}
	info.SizeBytes = st.Size()
	info.Container = strings.TrimPrefix(strings.ToLower(filepath.Ext(path)), ".")

	ffprobe, err := bin("ffprobe")
	if err != nil {
		return info, err
	}
	out, err := exec.Command(ffprobe,
		"-v", "error",
		"-select_streams", "v:0",
		"-show_entries", "stream=width,height,codec_name",
		"-show_entries", "format=duration",
		"-of", "json", path,
	).Output()
	if err != nil {
		return info, fmt.Errorf("ffprobe failed: %w", err)
	}
	var probe struct {
		Streams []struct {
			Width     int    `json:"width"`
			Height    int    `json:"height"`
			CodecName string `json:"codec_name"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(out, &probe); err != nil {
		return info, err
	}
	if len(probe.Streams) > 0 {
		info.Width = probe.Streams[0].Width
		info.Height = probe.Streams[0].Height
		info.Codec = probe.Streams[0].CodecName
	}
	if d, err := strconv.ParseFloat(probe.Format.Duration, 64); err == nil {
		info.Duration = d
	}
	return info, nil
}

// Produce writes the output in the chosen container at (approximately) the
// target size. If targetBytes is at/above the original size, it only changes
// the container losslessly (-c copy, no quality loss, same size). Otherwise it
// two-pass encodes to hit the target size.
func (s *VideoService) Produce(path string, targetBytes int64, targetHeight int, container string, outDir string, outName string) (ConvertResult, error) {
	ffmpeg, err := bin("ffmpeg")
	if err != nil {
		return ConvertResult{}, err
	}
	container = strings.ToLower(strings.TrimPrefix(container, "."))
	switch container {
	case "mp4", "mov", "mkv":
	default:
		return ConvertResult{}, fmt.Errorf("unsupported container %q (use mp4/mov/mkv)", container)
	}

	info, err := s.Probe(path)
	if err != nil {
		return ConvertResult{}, err
	}

	dir := outDirOr(outDir, path)
	srcBase := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	// User-supplied output name (sanitised); empty falls back to defaults.
	userBase := strings.TrimSpace(outName)
	if userBase != "" {
		userBase = filepath.Base(userBase)
		userBase = strings.TrimSuffix(userBase, "."+container)
	}

	// Lossless container change when the target is (near) the original size.
	if targetBytes >= int64(float64(info.SizeBytes)*0.98) {
		name := userBase
		if name == "" {
			name = srcBase
		}
		out := uniquePath(dir, name, container)
		if err := run(ffmpeg, []string{"-y", "-i", path, "-c", "copy", out}); err != nil {
			return ConvertResult{}, err
		}
		emitProgress(100)
		return result(path, out)
	}

	// Compress: two-pass encode to a computed bitrate so the output lands
	// close to the requested size.
	if info.Duration <= 0 {
		return ConvertResult{}, fmt.Errorf("could not read video duration")
	}
	totalKbps := float64(targetBytes) * 8 / info.Duration / 1000
	videoKbps := int(totalKbps) - audioKbps
	if videoKbps < 100 {
		videoKbps = 100
	}
	name := userBase
	if name == "" {
		name = srcBase + "-compressed"
	}
	out := uniquePath(dir, name, container)
	passlog := filepath.Join(os.TempDir(), "yyvp-2pass-"+strconv.Itoa(os.Getpid()))
	defer func() {
		_ = os.Remove(passlog + "-0.log")
		_ = os.Remove(passlog + "-0.log.mbtree")
	}()

	bv := strconv.Itoa(videoKbps) + "k"
	// Downscale when a smaller resolution is requested (keeps the picture
	// clean at low bitrates). Never upscale.
	var scale []string
	if targetHeight > 0 && targetHeight < info.Height {
		scale = []string{"-vf", fmt.Sprintf("scale=-2:%d", targetHeight)}
	}
	pass1 := append([]string{"-y", "-i", path}, scale...)
	pass1 = append(pass1, "-c:v", "libx264", "-b:v", bv,
		"-pass", "1", "-passlogfile", passlog, "-an", "-preset", "medium",
		"-f", "null", "/dev/null")
	if err := runWithProgress(ffmpeg, pass1, info.Duration, 0, 50); err != nil {
		return ConvertResult{}, err
	}
	pass2 := append([]string{"-y", "-i", path}, scale...)
	pass2 = append(pass2, "-c:v", "libx264", "-b:v", bv,
		"-pass", "2", "-passlogfile", passlog, "-preset", "medium",
		"-c:a", "aac", "-b:a", strconv.Itoa(audioKbps)+"k",
		out)
	if err := runWithProgress(ffmpeg, pass2, info.Duration, 50, 50); err != nil {
		return ConvertResult{}, err
	}
	return result(path, out)
}

func outDirOr(outDir, path string) string {
	if strings.TrimSpace(outDir) != "" {
		return outDir
	}
	return filepath.Dir(path)
}

// uniquePath returns a path in dir that does not collide with an existing
// file: name.ext, then name-1.ext, name-2.ext, ... Never overwrites.
func uniquePath(dir, name, ext string) string {
	p := filepath.Join(dir, name+"."+ext)
	if _, err := os.Stat(p); os.IsNotExist(err) {
		return p
	}
	for i := 1; ; i++ {
		p = filepath.Join(dir, fmt.Sprintf("%s-%d.%s", name, i, ext))
		if _, err := os.Stat(p); os.IsNotExist(err) {
			return p
		}
	}
}

// parseFFTime parses ffmpeg's HH:MM:SS.ffff into seconds; -1 if not parseable.
func parseFFTime(s string) float64 {
	parts := strings.Split(strings.TrimSpace(s), ":")
	if len(parts) != 3 {
		return -1
	}
	h, e1 := strconv.ParseFloat(parts[0], 64)
	m, e2 := strconv.ParseFloat(parts[1], 64)
	sec, e3 := strconv.ParseFloat(parts[2], 64)
	if e1 != nil || e2 != nil || e3 != nil {
		return -1
	}
	return h*3600 + m*60 + sec
}

func emitProgress(p float64) {
	if p > 100 {
		p = 100
	}
	if p < 0 {
		p = 0
	}
	application.Get().Event.Emit("produce:progress", p)
}

// runWithProgress runs ffmpeg while streaming real progress. duration is the
// clip length; the emitted percentage spans [base, base+span] as ffmpeg works.
func runWithProgress(ffmpeg string, args []string, duration, base, span float64) error {
	full := append([]string{"-nostats", "-progress", "pipe:1"}, args...)
	cmd := exec.Command(ffmpeg, full...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	sc := bufio.NewScanner(stdout)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "out_time=") {
			if sec := parseFFTime(strings.TrimPrefix(line, "out_time=")); sec >= 0 && duration > 0 {
				emitProgress(base + (sec/duration)*span)
			}
		}
	}
	if err := cmd.Wait(); err != nil {
		msg := stderr.String()
		if len(msg) > 400 {
			msg = msg[len(msg)-400:]
		}
		return fmt.Errorf("ffmpeg failed: %v: %s", err, msg)
	}
	emitProgress(base + span)
	return nil
}

func run(ffmpeg string, args []string) error {
	cmd := exec.Command(ffmpeg, args...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := stderr.String()
		if len(msg) > 400 {
			msg = msg[len(msg)-400:]
		}
		return fmt.Errorf("ffmpeg failed: %v: %s", err, msg)
	}
	return nil
}

func result(in, out string) (ConvertResult, error) {
	inSt, err := os.Stat(in)
	if err != nil {
		return ConvertResult{}, err
	}
	outSt, err := os.Stat(out)
	if err != nil {
		return ConvertResult{}, err
	}
	return ConvertResult{
		OutputPath:      out,
		OutputName:      filepath.Base(out),
		InputSizeBytes:  inSt.Size(),
		OutputSizeBytes: outSt.Size(),
	}, nil
}
