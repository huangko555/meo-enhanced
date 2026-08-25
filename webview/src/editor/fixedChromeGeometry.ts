export type FixedChromeRect = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

export type FixedChromeVector = {
  readonly x: number;
  readonly y: number;
};

export type FixedChromeGeometry = {
  readonly rect: FixedChromeRect;
  readonly vectors: readonly FixedChromeVector[];
};

/** Complete local-to-viewport two-dimensional affine mapping. */
export type FixedChromeAffineMapping = {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
};

export type FixedChromeGeometryFailure =
  | 'non-finite'
  | 'invalid-geometry'
  | 'singular'
  | 'non-axis-aligned'
  | 'negative-scale';

export type FixedChromeGeometryProjection =
  | { readonly ok: true; readonly geometry: FixedChromeGeometry }
  | { readonly ok: false; readonly reason: FixedChromeGeometryFailure };

const relativeTolerance = 1e-9;

export function fixedChromeAffineMappingFromSamples(
  origin: FixedChromeVector,
  horizontal: FixedChromeVector,
  vertical: FixedChromeVector,
  sampleDistance: number
): FixedChromeAffineMapping {
  return {
    a: (horizontal.x - origin.x) / sampleDistance,
    b: (horizontal.y - origin.y) / sampleDistance,
    c: (vertical.x - origin.x) / sampleDistance,
    d: (vertical.y - origin.y) / sampleDistance,
    e: origin.x,
    f: origin.y
  };
}

function allFinite(values: readonly number[]): boolean {
  return values.every(Number.isFinite);
}

/**
 * Projects viewport CSS geometry into one fixed containing block.
 *
 * The mapping must be complete, invertible, axis-aligned and forward-facing.
 * Failure is atomic: no partial geometry is returned.
 */
export function projectFixedChromeGeometry(
  localToViewport: FixedChromeAffineMapping,
  viewport: FixedChromeGeometry
): FixedChromeGeometryProjection {
  const matrixValues = [
    localToViewport.a,
    localToViewport.b,
    localToViewport.c,
    localToViewport.d,
    localToViewport.e,
    localToViewport.f
  ];
  const geometryValues = [
    viewport.rect.left,
    viewport.rect.top,
    viewport.rect.width,
    viewport.rect.height,
    ...viewport.vectors.flatMap((vector) => [vector.x, vector.y])
  ];
  if (!allFinite(matrixValues) || !allFinite(geometryValues)) {
    return { ok: false, reason: 'non-finite' };
  }
  if (viewport.rect.width < 0 || viewport.rect.height < 0) {
    return { ok: false, reason: 'invalid-geometry' };
  }

  const { a, b, c, d, e, f } = localToViewport;
  const scale = Math.max(1, Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
  const determinant = a * d - b * c;
  if (Math.abs(determinant) <= relativeTolerance * scale * scale) {
    return { ok: false, reason: 'singular' };
  }
  if (Math.abs(b) > relativeTolerance * scale || Math.abs(c) > relativeTolerance * scale) {
    return { ok: false, reason: 'non-axis-aligned' };
  }
  if (a < 0 || d < 0) return { ok: false, reason: 'negative-scale' };

  const inverseA = d / determinant;
  const inverseB = -b / determinant;
  const inverseC = -c / determinant;
  const inverseD = a / determinant;
  const inverseE = (c * f - d * e) / determinant;
  const inverseF = (b * e - a * f) / determinant;
  const point = (x: number, y: number): FixedChromeVector => ({
    x: inverseA * x + inverseC * y + inverseE,
    y: inverseB * x + inverseD * y + inverseF
  });
  const vector = (input: FixedChromeVector): FixedChromeVector => ({
    x: inverseA * input.x + inverseC * input.y,
    y: inverseB * input.x + inverseD * input.y
  });

  const topLeft = point(viewport.rect.left, viewport.rect.top);
  const bottomRight = point(
    viewport.rect.left + viewport.rect.width,
    viewport.rect.top + viewport.rect.height
  );
  const geometry: FixedChromeGeometry = {
    rect: {
      left: Math.min(topLeft.x, bottomRight.x),
      top: Math.min(topLeft.y, bottomRight.y),
      width: Math.abs(bottomRight.x - topLeft.x),
      height: Math.abs(bottomRight.y - topLeft.y)
    },
    vectors: viewport.vectors.map(vector)
  };
  if (!allFinite([
    geometry.rect.left,
    geometry.rect.top,
    geometry.rect.width,
    geometry.rect.height,
    ...geometry.vectors.flatMap((value) => [value.x, value.y])
  ])) {
    return { ok: false, reason: 'non-finite' };
  }
  return { ok: true, geometry };
}
