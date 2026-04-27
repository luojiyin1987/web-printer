function parseCopies(rawValue) {
  if (!rawValue) {
    return 1;
  }

  const copies = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(copies) || copies < 1 || copies > 999) {
    const error = new Error("copies must be an integer between 1 and 999.");
    error.statusCode = 400;
    throw error;
  }

  return copies;
}

function parsePageRanges(rawValue) {
  if (!rawValue || !String(rawValue).trim()) {
    return [];
  }

  const segments = String(rawValue)
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return [];
  }

  const ranges = segments.map((segment) => {
    const match = segment.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) {
      const error = new Error(
        "pageRanges must use formats like 1,3,5-8."
      );
      error.statusCode = 400;
      throw error;
    }

    const start = Number.parseInt(match[1], 10);
    const end = Number.parseInt(match[2] || match[1], 10);

    if (start < 1 || end < 1 || start > end) {
      const error = new Error(
        "pageRanges must contain positive page numbers and valid ranges."
      );
      error.statusCode = 400;
      throw error;
    }

    return [start, end];
  });

  ranges.sort((left, right) => {
    if (left[0] !== right[0]) {
      return left[0] - right[0];
    }

    return left[1] - right[1];
  });

  return ranges.reduce((merged, current) => {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push(current);
      return merged;
    }

    if (current[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], current[1]);
      return merged;
    }

    merged.push(current);
    return merged;
  }, []);
}

function formatPageRanges(ranges) {
  return ranges
    .map(([start, end]) => (start === end ? String(start) : `${start}-${end}`))
    .join(",");
}

module.exports = {
  parseCopies,
  parsePageRanges,
  formatPageRanges,
};
