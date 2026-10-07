import { describe, expect, it } from "vitest";
import {
  areaLayer,
  axisGridLayer,
  barLayer,
  boxPlotLayer,
  candlestickLayer,
  currentTimeLayer,
  eventMarkerLayer,
  heatmapLayer,
  heatmapStreamLayer,
  histogramLayer,
  lidarLayer,
  lineLayer,
  lineStaticLayer,
  occupancyGridLayer,
  polarLayer,
  poseArrowLayer,
  referenceLineLayer,
  scatterColoredLayer,
  scatterLayer,
  spectrogramLayer,
  stackedAreaLayer,
  stepLayer,
  trajectoryLayer,
} from "./layer-specs";

describe("lineLayer", () => {
  it("returns kind=line with given id", () => {
    const spec = lineLayer("myLine");
    expect(spec.kind).toBe("line");
    expect(spec.id).toBe("myLine");
  });

  it("passes config through", () => {
    const config = { color: "#ff0000" };
    const spec = lineLayer("l", config);
    expect(spec.config).toBe(config);
  });

  it("config is undefined when not provided", () => {
    const spec = lineLayer("l");
    expect(spec.config).toBeUndefined();
  });
});

describe("lineStaticLayer", () => {
  it("returns kind=line-static with given id", () => {
    const spec = lineStaticLayer("ls");
    expect(spec.kind).toBe("line-static");
    expect(spec.id).toBe("ls");
  });

  it("passes config through", () => {
    const config = { color: "#00ff00" };
    const spec = lineStaticLayer("ls", config);
    expect(spec.config).toBe(config);
  });
});

describe("lidarLayer", () => {
  it("returns kind=lidar with given id", () => {
    const spec = lidarLayer("lid");
    expect(spec.kind).toBe("lidar");
    expect(spec.id).toBe("lid");
  });

  it("passes config through", () => {
    const config = { stride: 4 as const };
    const spec = lidarLayer("lid", config);
    expect(spec.config).toBe(config);
  });
});

describe("axisGridLayer", () => {
  it("returns kind=axis-grid with given id", () => {
    const spec = axisGridLayer("axis");
    expect(spec.kind).toBe("axis-grid");
    expect(spec.id).toBe("axis");
  });

  it("passes config through", () => {
    const config = { xMode: "time" as const, timeWindowMs: 5000 };
    const spec = axisGridLayer("axis", config);
    expect(spec.config).toBe(config);
  });
});

describe("scatterLayer", () => {
  it("returns kind=scatter with given id", () => {
    const spec = scatterLayer("sc");
    expect(spec.kind).toBe("scatter");
    expect(spec.id).toBe("sc");
  });

  it("config is undefined when not provided", () => {
    expect(scatterLayer("sc").config).toBeUndefined();
  });
});

describe("areaLayer", () => {
  it("returns kind=area with given id", () => {
    const spec = areaLayer("ar");
    expect(spec.kind).toBe("area");
    expect(spec.id).toBe("ar");
  });
});

describe("stepLayer", () => {
  it("returns kind=step with given id", () => {
    const spec = stepLayer("st");
    expect(spec.kind).toBe("step");
    expect(spec.id).toBe("st");
  });
});

describe("barLayer", () => {
  it("returns kind=bar with given id", () => {
    const spec = barLayer("br");
    expect(spec.kind).toBe("bar");
    expect(spec.id).toBe("br");
  });
});

describe("candlestickLayer", () => {
  it("returns kind=candlestick with given id", () => {
    const spec = candlestickLayer("cs");
    expect(spec.kind).toBe("candlestick");
    expect(spec.id).toBe("cs");
  });
});

describe("heatmapLayer", () => {
  it("returns kind=heatmap with given id", () => {
    const spec = heatmapLayer("hm");
    expect(spec.kind).toBe("heatmap");
    expect(spec.id).toBe("hm");
  });
});

describe("eventMarkerLayer", () => {
  it("returns kind=event-marker with given id", () => {
    const spec = eventMarkerLayer("em");
    expect(spec.kind).toBe("event-marker");
    expect(spec.id).toBe("em");
  });
});

describe("scatterColoredLayer", () => {
  it("returns kind=scatter-colored with given id", () => {
    const spec = scatterColoredLayer("scc");
    expect(spec.kind).toBe("scatter-colored");
    expect(spec.id).toBe("scc");
  });
});

describe("heatmapStreamLayer", () => {
  it("returns kind=heatmap-stream with given id", () => {
    const spec = heatmapStreamLayer("hs");
    expect(spec.kind).toBe("heatmap-stream");
    expect(spec.id).toBe("hs");
  });
});

describe("referenceLineLayer", () => {
  it("returns kind=reference-line with given id", () => {
    const spec = referenceLineLayer("rl");
    expect(spec.kind).toBe("reference-line");
    expect(spec.id).toBe("rl");
  });
});

describe("poseArrowLayer", () => {
  it("returns kind=pose-arrow with given id", () => {
    const spec = poseArrowLayer("pa");
    expect(spec.kind).toBe("pose-arrow");
    expect(spec.id).toBe("pa");
  });
});

describe("trajectoryLayer", () => {
  it("returns kind=trajectory with given id", () => {
    const spec = trajectoryLayer("tj");
    expect(spec.kind).toBe("trajectory");
    expect(spec.id).toBe("tj");
  });
});

describe("occupancyGridLayer", () => {
  it("returns kind=occupancy-grid with given id", () => {
    const spec = occupancyGridLayer("og");
    expect(spec.kind).toBe("occupancy-grid");
    expect(spec.id).toBe("og");
  });
});

describe("histogramLayer", () => {
  it("returns kind=histogram with given id", () => {
    const spec = histogramLayer("hg");
    expect(spec.kind).toBe("histogram");
    expect(spec.id).toBe("hg");
  });
});

describe("stackedAreaLayer", () => {
  it("returns kind=stacked-area with given id", () => {
    const spec = stackedAreaLayer("sa");
    expect(spec.kind).toBe("stacked-area");
    expect(spec.id).toBe("sa");
  });
});

describe("boxPlotLayer", () => {
  it("returns kind=box-plot with given id", () => {
    const spec = boxPlotLayer("bp");
    expect(spec.kind).toBe("box-plot");
    expect(spec.id).toBe("bp");
  });
});

describe("polarLayer", () => {
  it("returns kind=polar with given id", () => {
    const spec = polarLayer("pl");
    expect(spec.kind).toBe("polar");
    expect(spec.id).toBe("pl");
  });
});

describe("spectrogramLayer", () => {
  it("maps to a heatmap-stream spec with defaults", () => {
    const spec = spectrogramLayer("sp");
    expect(spec.kind).toBe("heatmap-stream");
    expect(spec.id).toBe("sp");
    const cfg = spec.config as {
      yBins: number;
      yRange: [number, number];
      maxCols: number;
      colormap: string;
    };
    expect(cfg.yBins).toBe(64);
    expect(cfg.yRange).toEqual([0, 1]);
    expect(cfg.maxCols).toBe(256);
    expect(cfg.colormap).toBe("viridis");
  });

  it("threads freqBins/freqRange/maxCols/colormap/minDb/maxDb through", () => {
    const spec = spectrogramLayer("sp", {
      freqBins: 128,
      freqRange: [20, 20000],
      maxCols: 512,
      colormap: "plasma",
      minDb: -100,
      maxDb: 0,
      visible: false,
    });
    const cfg = spec.config as {
      yBins: number;
      yRange: [number, number];
      maxCols: number;
      colormap: string;
      minValue: number;
      maxValue: number;
      visible: boolean;
    };
    expect(cfg.yBins).toBe(128);
    expect(cfg.yRange).toEqual([20, 20000]);
    expect(cfg.maxCols).toBe(512);
    expect(cfg.colormap).toBe("plasma");
    expect(cfg.minValue).toBe(-100);
    expect(cfg.maxValue).toBe(0);
    expect(cfg.visible).toBe(false);
  });
});

describe("all layer factories", () => {
  it("each factory returns an object with id, kind, and config properties", () => {
    const factories = [
      lineLayer("a"),
      lineStaticLayer("b"),
      lidarLayer("c"),
      axisGridLayer("d"),
      scatterLayer("e"),
      areaLayer("f"),
      stepLayer("g"),
      barLayer("h"),
      candlestickLayer("i"),
      heatmapLayer("j"),
      eventMarkerLayer("k"),
      scatterColoredLayer("l"),
      heatmapStreamLayer("m"),
      referenceLineLayer("n"),
      poseArrowLayer("o"),
      trajectoryLayer("p"),
      occupancyGridLayer("q"),
      histogramLayer("r"),
      stackedAreaLayer("s"),
      boxPlotLayer("t"),
      polarLayer("u"),
    ];

    for (const spec of factories) {
      expect(spec).toHaveProperty("id");
      expect(spec).toHaveProperty("kind");
      expect("config" in spec).toBe(true);
    }
  });

  it("each factory preserves the provided id", () => {
    const id = "unique-test-id";
    const specs = [
      lineLayer(id),
      lineStaticLayer(id),
      lidarLayer(id),
      axisGridLayer(id),
      scatterLayer(id),
      areaLayer(id),
      stepLayer(id),
      barLayer(id),
      candlestickLayer(id),
      heatmapLayer(id),
      eventMarkerLayer(id),
      scatterColoredLayer(id),
      heatmapStreamLayer(id),
      referenceLineLayer(id),
      poseArrowLayer(id),
      trajectoryLayer(id),
      occupancyGridLayer(id),
      histogramLayer(id),
      stackedAreaLayer(id),
      boxPlotLayer(id),
      polarLayer(id),
    ];

    for (const spec of specs) {
      expect(spec.id).toBe(id);
    }
  });
});

it("currentTimeLayer exposes optional live and controlled configs", () => {
  expect(currentTimeLayer("now")).toEqual({
    id: "now",
    kind: "current-time",
    config: undefined,
  });
  const config = { currentTime: 1234, lineWidth: 2 };
  expect(currentTimeLayer("playhead", config).config).toBe(config);
});
