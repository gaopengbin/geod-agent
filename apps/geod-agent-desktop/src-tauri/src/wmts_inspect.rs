//! Bounded WMTS metadata inspection. Matrices/templates/time domains are read
//! from the provider, never guessed from a layer name or file extension.
use crate::{workspace_error, AppError};
use roxmltree::{Document, Node};
use serde_json::{json, Value};
fn child<'a, 'b>(node: Node<'a, 'b>, name: &str) -> Option<Node<'a, 'b>> {
    node.children()
        .find(|n| n.is_element() && n.tag_name().name() == name)
}
fn field(node: Node<'_, '_>, name: &str) -> String {
    child(node, name)
        .and_then(|n| n.text())
        .unwrap_or("")
        .trim()
        .chars()
        .take(2000)
        .collect()
}
fn z_id(id: &str) -> Option<(u8, String)> {
    if let Ok(z) = id.parse::<u8>() {
        return Some((z, String::new()));
    }
    let (prefix, z) = id.rsplit_once(':')?;
    Some((z.parse().ok()?, format!("{prefix}:")))
}
fn xyz(set: Node<'_, '_>) -> Option<(u8, u8, u16, String)> {
    let crs = field(set, "SupportedCRS");
    if !crs.to_uppercase().contains("EPSG")
        || crs.rsplit([':', '/']).find(|s| !s.is_empty()) != Some("3857")
    {
        return None;
    }
    let mut levels = Vec::new();
    let mut size = None;
    let mut prefix = None;
    for matrix in set
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "TileMatrix")
    {
        let (z, p) = z_id(&field(matrix, "Identifier"))?;
        if z > 22 {
            return None;
        }
        let w = field(matrix, "TileWidth").parse::<u16>().ok()?;
        let h = field(matrix, "TileHeight").parse::<u16>().ok()?;
        if w != h
            || !matches!(w, 256 | 512)
            || size.is_some_and(|s| s != w)
            || prefix.as_ref().is_some_and(|s| s != &p)
        {
            return None;
        }
        let cols = field(matrix, "MatrixWidth").parse::<u64>().ok()?;
        let rows = field(matrix, "MatrixHeight").parse::<u64>().ok()?;
        if cols != 1u64 << z || rows != 1u64 << z {
            return None;
        }
        let scale = field(matrix, "ScaleDenominator").parse::<f64>().ok()?;
        let expected = 40075016.68557849 / (f64::from(w) * (1u64 << z) as f64 * 0.00028);
        if !scale.is_finite() || (scale - expected).abs() > expected * 0.00001 {
            return None;
        }
        let origin: Vec<f64> = field(matrix, "TopLeftCorner")
            .split_whitespace()
            .filter_map(|s| s.parse().ok())
            .collect();
        if origin.len() != 2
            || (origin[0] + 20037508.342789244).abs() > 0.1
            || (origin[1] - 20037508.342789244).abs() > 0.1
        {
            return None;
        }
        size = Some(w);
        prefix = Some(p);
        levels.push(z);
    }
    levels.sort_unstable();
    if levels.is_empty() || levels.windows(2).any(|z| z[1] != z[0] + 1) {
        return None;
    }
    Some((*levels.first()?, *levels.last()?, size?, prefix?))
}
pub(crate) fn inspect(xml: &str, args: &Value) -> Result<Value, AppError> {
    let document = Document::parse(xml)
        .map_err(|_| workspace_error("SOURCE_XML_INVALID", "服务未返回有效的 WMTS XML 元数据"))?;
    let root = document.root_element();
    let Some(contents) = child(root, "Contents") else {
        return Err(workspace_error(
            "WMTS_CAPABILITIES_REQUIRED",
            "该 XML 不是 WMTS GetCapabilities，无法据此配置瓦片来源",
        ));
    };
    let query = args["query"].as_str().unwrap_or("").to_lowercase();
    let tokens: Vec<_> = query.split_whitespace().collect();
    let layers: Vec<_> = contents
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "Layer")
        .filter(|n| {
            let text = format!(
                "{} {} {}",
                field(*n, "Identifier"),
                field(*n, "Title"),
                field(*n, "Abstract")
            )
            .to_lowercase();
            tokens.iter().all(|q| text.contains(q))
        })
        .collect();
    let offset = args["offset"].as_u64().unwrap_or(0) as usize;
    let limit = args["limit"].as_u64().unwrap_or(12).clamp(1, 32) as usize;
    let mut result = Vec::new();
    for layer in layers.iter().skip(offset).take(limit) {
        let id = field(*layer, "Identifier");
        let style = layer
            .children()
            .filter(|n| n.is_element() && n.tag_name().name() == "Style")
            .find(|n| n.attribute("isDefault") == Some("true"))
            .or_else(|| child(*layer, "Style"))
            .map(|n| field(n, "Identifier"))
            .unwrap_or_default();
        let dimensions:Vec<Value>=layer.children().filter(|n|n.is_element()&&n.tag_name().name()=="Dimension").map(|n|{let values:Vec<_>=n.children().filter(|v|v.is_element()&&v.tag_name().name()=="Value").filter_map(|n|n.text()).collect();let page=if values.len()<=8{values.clone()}else{values.iter().take(4).chain(values.iter().rev().take(4)).copied().collect()};json!({"id":field(n,"Identifier"),"default":field(n,"Default"),"values":page,"valueCount":values.len()})}).collect();
        let selected = args["time"].as_str().filter(|s| {
            s.len() <= 40
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-:._+".contains(&b))
        });
        let advertised = selected.is_some_and(|selected| {
            layer
                .children()
                .filter(|n| {
                    n.is_element()
                        && n.tag_name().name() == "Dimension"
                        && field(*n, "Identifier").eq_ignore_ascii_case("time")
                })
                .any(|n| {
                    field(n, "Default") == selected
                        || n.children()
                            .filter(|v| v.is_element() && v.tag_name().name() == "Value")
                            .filter_map(|v| v.text())
                            .any(|v| {
                                if v == selected {
                                    return true;
                                }
                                let p: Vec<_> = v.split('/').collect();
                                p.len() == 3
                                    && p[2] == "P1D"
                                    && chrono::NaiveDate::parse_from_str(selected, "%Y-%m-%d")
                                        .is_ok()
                                    && p[0].get(..10).is_some_and(|first| first <= selected)
                                    && p[1].get(..10).is_some_and(|last| selected <= last)
                            })
                })
        });
        let mut grids = Vec::new();
        let mut candidates = Vec::new();
        for link in layer
            .children()
            .filter(|n| n.is_element() && n.tag_name().name() == "TileMatrixSetLink")
        {
            let set_id = field(link, "TileMatrixSet");
            let set = contents.children().find(|n| {
                n.is_element()
                    && n.tag_name().name() == "TileMatrixSet"
                    && field(*n, "Identifier") == set_id
            });
            let compatible = set.and_then(xyz);
            grids.push(json!({"id":set_id,"crs":set.map(|n|field(n,"SupportedCRS")),"nativeXyzCompatible":compatible.is_some()}));
            if let Some((min, max, size, prefix)) = compatible {
                for resource in layer.children().filter(|n| {
                    n.is_element()
                        && n.tag_name().name() == "ResourceURL"
                        && n.attribute("resourceType") == Some("tile")
                }) {
                    let format = resource.attribute("format").unwrap_or("");
                    let template = resource.attribute("template").unwrap_or("");
                    let mut url = template
                        .replace("{Layer}", &id)
                        .replace("{Style}", &style)
                        .replace("{TileMatrixSet}", &set_id)
                        .replace("{TileMatrix}", &format!("{prefix}{{z}}"))
                        .replace("{TileRow}", "{y}")
                        .replace("{TileCol}", "{x}");
                    if let Some(time) = selected {
                        url = url.replace("{Time}", time).replace("{time}", time);
                    }
                    let has_time = template.contains("{Time}") || template.contains("{time}");
                    let time_required = has_time && (!advertised || selected.is_none());
                    let supported = matches!(format, "image/png" | "image/jpeg" | "image/jpg");
                    candidates.push(json!({"format":format,"resourceTemplate":template,"requiresTimeSelection":time_required,"selectedTime":selected,"timeSelectionAdvertised":advertised,"renderedImageSupported":supported,"candidate":if supported&&!time_required{json!({"urlTemplate":url,"scheme":"XYZ","tileSize":size,"minZoom":min,"maxZoom":max,"minIntervalMs":0})}else{Value::Null},"pixelMeaning":if supported{"rendered colors, not original scientific radiance"}else{"unverified binary encoding; an image extension or layer name does not prove a numeric decoder is available"}}));
                }
            }
        }
        result.push(json!({"id":id,"title":field(*layer,"Title"),"style":style,"dimensions":dimensions,"matrixSets":grids,"resources":candidates}));
    }
    Ok(
        json!({"kind":"WMTS capabilities","metadataVerified":true,"sampleImageVerified":false,"layers":result,"totalMatches":layers.len(),"offset":offset,"nextOffset":if offset+limit<layers.len(){Some(offset+limit)}else{None},"next":"Use the exact returned ResourceURL, matrix set, format and time domain. Do not invent extensions or matrix identifiers after a 404. Dates describe the provider domain, not confirmed cloud-free acquisition at the requested location. Numeric/LERC data requires a verified raw decoder; rendered GeoTIFF is not a substitute."}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    const XML: &str = r#"<Capabilities xmlns='http://www.opengis.net/wmts/1.0' xmlns:ows='http://www.opengis.net/ows/1.1'><Contents><Layer><ows:Identifier>actual_observation</ows:Identifier><ows:Title>Real scientific layer</ows:Title><Style isDefault='true'><ows:Identifier>default</ows:Identifier></Style><Dimension><ows:Identifier>Time</ows:Identifier><Default>2026-10-27</Default><Value>2026-01-01/2026-10-27/P1D</Value></Dimension><TileMatrixSetLink><TileMatrixSet>actual_grid</TileMatrixSet></TileMatrixSetLink><ResourceURL resourceType='tile' format='image/png' template='https://data.example.org/{Layer}/{Style}/{Time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png'/><ResourceURL resourceType='tile' format='image/lerc' template='https://data.example.org/numeric/{Time}/{TileMatrix}/{TileRow}/{TileCol}.lerc'/></Layer><TileMatrixSet><ows:Identifier>actual_grid</ows:Identifier><ows:SupportedCRS>urn:ogc:def:crs:EPSG::3857</ows:SupportedCRS><TileMatrix><ows:Identifier>0</ows:Identifier><ScaleDenominator>559082264.0287178</ScaleDenominator><TopLeftCorner>-20037508.342789244 20037508.342789244</TopLeftCorner><TileWidth>256</TileWidth><TileHeight>256</TileHeight><MatrixWidth>1</MatrixWidth><MatrixHeight>1</MatrixHeight></TileMatrix></TileMatrixSet></Contents></Capabilities>"#;
    #[test]
    fn exact_templates_formats_dates_and_native_matrix_are_retained() {
        let needs = inspect(XML, &json!({"query":"scientific"})).unwrap();
        assert_eq!(
            needs["layers"][0]["resources"][0]["requiresTimeSelection"],
            true
        );
        let ready = inspect(XML, &json!({"query":"observation","time":"2026-10-27"})).unwrap();
        let r = &ready["layers"][0]["resources"];
        assert_eq!(r[0]["candidate"]["urlTemplate"],"https://data.example.org/actual_observation/default/2026-10-27/actual_grid/{z}/{y}/{x}.png");
        assert!(r[1]["candidate"].is_null());
        assert_eq!(ready["sampleImageVerified"], false);
        assert!(
            inspect(XML, &json!({"time":"2027-01-01"})).unwrap()["layers"][0]["resources"][0]
                ["candidate"]
                .is_null()
        );
    }
    #[test]
    fn non_xyz_matrices_are_never_relabelled_and_unknown_layers_stay_unknown() {
        let shifted = XML.replace("urn:ogc:def:crs:EPSG::3857", "EPSG:4326");
        assert_eq!(
            inspect(&shifted, &json!({})).unwrap()["layers"][0]["matrixSets"][0]
                ["nativeXyzCompatible"],
            false
        );
        assert_eq!(
            inspect(XML, &json!({"query":"not present"})).unwrap()["totalMatches"],
            0
        );
    }
}
