"""Export ParcelMap BC parcels that intersect an area of interest."""

import argparse
import json
import math
from pathlib import Path
from tempfile import TemporaryDirectory

import geopandas as gpd
import pandas as pd
import requests
from shapely import orient_polygons


QUERY_URL = (
    "https://delivery.maps.gov.bc.ca/arcgis/rest/services/whse/"
    "bcgw_pub_whse_cadastre/MapServer/0/query"
)
BATCH_SIZE = 200
FIELDS = {
    "OBJECTID": ("OBJECTID", "int64"),
    "PARCEL_FABRIC_POLY_ID": ("FABRIC_ID", "int64"),
    "PID": ("PID", "object"),
    "PIN": ("PIN", "Int64"),
    "PARCEL_NAME": ("NAME", "object"),
    "PLAN_NUMBER": ("PLAN_NO", "object"),
    "PARCEL_STATUS": ("STATUS", "object"),
    "PARCEL_CLASS": ("CLASS", "object"),
    "OWNER_TYPE": ("OWNER_TYPE", "object"),
    "MUNICIPALITY": ("MUNICIPAL", "object"),
    "REGIONAL_DISTRICT": ("REG_DIST", "object"),
    "FEATURE_AREA_SQM": ("AREA_SQM", "float64"),
}


def area_parameters(args):
    if args.bbox is not None:
        west, south, east, north = args.bbox
        if not (
            all(map(math.isfinite, args.bbox))
            and -180 <= west < east <= 180
            and -90 <= south < north <= 90
        ):
            raise ValueError("Use an ordered WGS 84 bounding box: WEST SOUTH EAST NORTH.")
        return {
            "geometry": ",".join(map(str, args.bbox)),
            "geometryType": "esriGeometryEnvelope",
            "inSR": 4326,
        }

    area = gpd.read_file(args.area)
    if area.crs is None:
        raise ValueError("The area file must have a coordinate reference system.")
    shapes = area.geometry.dropna()
    shapes = shapes[~shapes.is_empty]
    if shapes.empty or not shapes.geom_type.isin(["Polygon", "MultiPolygon"]).all():
        raise ValueError("The area file must contain polygon geometries.")
    if not shapes.is_valid.all():
        raise ValueError("The area file contains invalid polygons. Repair them before exporting.")

    boundary = orient_polygons(shapes.to_crs(3005).union_all(), exterior_cw=True)
    polygons = boundary.geoms if boundary.geom_type == "MultiPolygon" else [boundary]
    rings = [
        [[x, y] for x, y, *_ in ring.coords]
        for polygon in polygons
        for ring in (polygon.exterior, *polygon.interiors)
    ]
    return {
        "geometry": json.dumps({"rings": rings}),
        "geometryType": "esriGeometryPolygon",
        "inSR": 3005,
    }


def query(session, **parameters):
    response = session.post(QUERY_URL, data=parameters, timeout=(10, 120))
    response.raise_for_status()
    result = response.json()
    if "error" in result:
        error = result["error"]
        details = " ".join(error.get("details") or [])
        raise ValueError(f"ParcelMap BC: {error['message']} {details}".strip())
    return result


def fetch_parcels(session, area):
    matches = query(
        session,
        **area,
        f="json",
        where="1=1",
        spatialRel="esriSpatialRelIntersects",
        returnIdsOnly="true",
    )
    if matches.get("exceededTransferLimit") or "objectIds" not in matches:
        raise ValueError("ParcelMap BC did not return a complete list of matching IDs.")
    ids = sorted(set(matches["objectIds"] or []))
    features = []
    for start in range(0, len(ids), BATCH_SIZE):
        batch = ids[start : start + BATCH_SIZE]
        result = query(
            session,
            f="geojson",
            objectIds=",".join(map(str, batch)),
            outFields=",".join(FIELDS),
            outSR=4326,
            returnGeometry="true",
        )
        page = result["features"]
        returned = {feature["properties"]["OBJECTID"] for feature in page}
        if (
            result.get("exceededTransferLimit")
            or returned != set(batch)
            or len(page) != len(batch)
            or any(not feature["geometry"] for feature in page)
        ):
            raise ValueError("ParcelMap BC returned an incomplete batch. Retry the export.")
        features.extend(page)

    parcels = gpd.GeoDataFrame.from_features(
        features, columns=[*FIELDS, "geometry"], crs=4326
    )
    for source, (_, dtype) in FIELDS.items():
        parcels[source] = pd.array(parcels[source], dtype=dtype)
    return parcels.rename(columns={source: name for source, (name, _) in FIELDS.items()})


def write_shapefile(parcels, output):
    output.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=output.parent) as staging:
        staged = Path(staging) / output.name
        parcels.to_crs(3005).to_file(
            staged, driver="ESRI Shapefile", engine="pyogrio",
            geometry_type="Polygon", encoding="UTF-8", index=False,
        )
        files = [(part, output.parent / part.name) for part in staged.parent.iterdir()]
        for _, target in files:
            if target.exists():
                raise ValueError(f"Output already exists: {target}")
        published = []
        try:
            for part, target in files:
                # An exclusive create also protects against another export to this path.
                with target.open("xb") as destination:
                    published.append(target)
                    destination.write(part.read_bytes())
        except OSError:
            for target in published:
                target.unlink()
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    area = parser.add_mutually_exclusive_group(required=True)
    area.add_argument("--bbox", nargs=4, type=float, metavar=("WEST", "SOUTH", "EAST", "NORTH"))
    area.add_argument("--area", type=Path, help="Polygon file such as a GeoJSON or shapefile")
    parser.add_argument("--output", required=True, type=Path, help="Path for the output .shp")
    args = parser.parse_args()
    if args.output.suffix != ".shp":
        parser.error("--output must end in .shp")

    try:
        parameters = area_parameters(args)
        with requests.Session() as session:
            parcels = fetch_parcels(session, parameters)
        write_shapefile(parcels, args.output)
    except (OSError, ValueError, KeyError, requests.RequestException) as error:
        parser.exit(1, f"Export failed: {error}\n")
    print(f"Wrote {len(parcels):,} parcels to {args.output}")


if __name__ == "__main__":
    main()
