//! WFS metadata from actual XML; no external schema/entity resolution.
use crate::{workspace_error,AppError};
use reqwest::Url;
use roxmltree::{Document,Node,ParsingOptions};
use serde_json::{json,Value};
fn xml(bytes:&[u8])->Result<Document<'_>,AppError>{
    let text=std::str::from_utf8(bytes).map_err(|_|workspace_error("INPUT_FORMAT_UNSUPPORTED","WFS XML 不是有效 UTF-8"))?;
    let doc=Document::parse_with_options(text,ParsingOptions{allow_dtd:false,nodes_limit:200_000}).map_err(|_|workspace_error("INPUT_FORMAT_UNSUPPORTED","WFS XML 无效或包含外部实体声明"))?;
    if doc.descendants().any(|n|n.is_element()&&matches!(n.tag_name().name(),"Exception"|"ServiceException")){return Err(workspace_error("INPUT_NETWORK_FAILED","WFS 服务拒绝查询，请检查图层、条件或认证"));}
    Ok(doc)
}
fn text(node:Node<'_, '_>,names:&[&str])->Option<String>{node.children().find(|n|n.is_element()&&names.contains(&n.tag_name().name())).and_then(|n|n.text()).map(|s|s.trim().into())}
fn operation(doc:&Document<'_>,name:&str,base:&Url)->Option<Url>{
    let modern=doc.descendants().find(|n|n.is_element()&&n.tag_name().name()=="Operation"&&n.attribute("name")==Some(name));
    let legacy=doc.descendants().find(|n|n.is_element()&&n.tag_name().name()==name&&n.parent().is_some_and(|p|p.tag_name().name()=="Request"));
    modern.or(legacy).and_then(|n|n.descendants().find(|n|n.is_element()&&n.tag_name().name()=="Get")).and_then(|n|n.attribute(("http://www.w3.org/1999/xlink","href")).or(n.attribute("onlineResource"))).and_then(|s|base.join(s).ok())
}
pub(crate) fn is_wfs(url:&Url)->bool{url.query_pairs().any(|(k,v)|k.eq_ignore_ascii_case("service")&&v.eq_ignore_ascii_case("wfs"))||url.path().trim_end_matches('/').to_ascii_lowercase().ends_with("/wfs")}
pub(crate) fn capabilities(bytes:&[u8],base:&Url)->Result<Value,AppError>{
    let doc=xml(bytes)?;let root=doc.root_element();
    if root.tag_name().name()!="WFS_Capabilities" {return Err(workspace_error("INPUT_FORMAT_UNSUPPORTED","服务没有返回 WFS 能力目录"));}
    let version=root.attribute("version").unwrap_or("1.0.0");
    if !matches!(version,"1.0.0"|"1.1.0"|"2.0.0"){return Err(workspace_error("INPUT_FORMAT_UNSUPPORTED","此 WFS 协议版本尚不支持"));}
    let get_feature=operation(&doc,"GetFeature",base).unwrap_or(base.clone());
    let describe=operation(&doc,"DescribeFeatureType",base).unwrap_or(base.clone());
    if get_feature.origin()!=base.origin()||describe.origin()!=base.origin(){return Err(workspace_error("INPUT_REDIRECT","WFS 操作指向其他地址，请为该地址另建连接"));}
    let mut formats=vec![];
    for node in doc.descendants().filter(|n|n.is_element()&&n.tag_name().name()=="Operation"&&n.attribute("name")==Some("GetFeature")){
        for parameter in node.descendants().filter(|n|n.is_element()&&n.tag_name().name()=="Parameter"&&n.attribute("name")==Some("outputFormat")){
            formats.extend(parameter.descendants().filter(|n|n.is_element()&&n.tag_name().name()=="Value").filter_map(|n|n.text().map(str::trim)).filter(|s|!s.is_empty()).map(str::to_owned));
        }
    }
    for node in doc.descendants().filter(|n|n.is_element()&&n.tag_name().name()=="ResultFormat"){formats.extend(node.children().filter(Node::is_element).map(|n|n.tag_name().name().into()));}
    formats.sort();formats.dedup();
    let layers:Vec<_>=doc.descendants().filter(|n|n.is_element()&&n.tag_name().name()=="FeatureType").filter_map(|n|{
        let name=text(n,&["Name"])?;let default=text(n,&["DefaultCRS","DefaultSRS","SRS"]);
        let mut crs:Vec<_>=n.children().filter(|c|c.is_element()&&matches!(c.tag_name().name(),"DefaultCRS"|"OtherCRS"|"DefaultSRS"|"OtherSRS"|"SRS")).filter_map(|c|c.text().map(|s|s.trim().to_owned())).collect();crs.sort();crs.dedup();
        let bounds=n.children().find(|c|c.is_element()&&matches!(c.tag_name().name(),"WGS84BoundingBox"|"LatLongBoundingBox")).and_then(|b|{
            if b.tag_name().name()=="LatLongBoundingBox"{let values:[Option<f64>;4]=["minx","miny","maxx","maxy"].map(|key|b.attribute(key).and_then(|v|v.parse().ok()));values.into_iter().collect::<Option<Vec<_>>>()}
            else{let lower=text(b,&["LowerCorner"])?;let upper=text(b,&["UpperCorner"])?;lower.split_whitespace().chain(upper.split_whitespace()).map(str::parse::<f64>).collect::<Result<Vec<_>,_>>().ok()}
        }).filter(|b|b.len()==4&&b.iter().all(|v|v.is_finite()));
        Some(json!({"name":name,"title":text(n,&["Title"]).unwrap_or(name.clone()),"geometryType":"FeatureCollection","defaultCrs":default,"crs":crs,"bounds":bounds,"queryUrl":get_feature,"describeUrl":describe}))
    }).collect();
    Ok(json!({"kind":"wfs","version":version,"outputFormats":formats,"layers":layers,"supportsStandardPaging":version=="2.0.0"}))
}
pub(crate) fn fields(bytes:&[u8])->Result<Vec<Value>,AppError>{
    let doc=xml(bytes)?;if doc.root_element().tag_name().name()!="schema"{return Err(workspace_error("INPUT_FORMAT_UNSUPPORTED","WFS 没有返回图层结构"));}
    Ok(doc.descendants().filter(|n|n.is_element()&&n.tag_name().name()=="element"&&n.ancestors().any(|p|p.is_element()&&p.tag_name().name()=="sequence")).filter_map(|n|{
        Some(json!({"name":n.attribute("name")?,"type":n.attribute("type"),"nullable":n.attribute("nillable")==Some("true")||n.attribute("minOccurs")==Some("0")}))
    }).collect())
}
pub(crate) fn canonical_crs(value:&str)->String{
    let value=value.trim().trim_matches(['<','>']);let upper=value.to_ascii_uppercase();
    if upper.contains("CRS84"){return "OGC:CRS84".into();}
    if upper.contains("EPSG"){if let Some(code)=upper.rsplit([':', '/', '#']).next().filter(|s|!s.is_empty()&&s.bytes().all(|b|b.is_ascii_digit())){return format!("EPSG:{code}");}}
    value.into()
}
pub(crate) fn response_crs(value:&mut Value,header:Option<&str>)->Result<(),AppError>{
    if value["type"]!="FeatureCollection"{return Ok(());}
    let declared=value["crs"]["properties"]["name"].as_str().or_else(||value["crs"].as_str()).map(canonical_crs);
    if let Some(crs)=&declared{value["crs"]=json!({"type":"name","properties":{"name":crs}});}
    if let Some(header)=header{
        let crs=canonical_crs(header);
        if declared.is_some_and(|e|e!=crs){return Err(workspace_error("INPUT_CRS_REQUIRED","服务的坐标系声明与响应头不一致"));}
        value["crs"]=json!({"type":"name","properties":{"name":crs}});
    }
    Ok(())
}
pub(crate) fn hits(bytes:&[u8])->Result<Option<u64>,AppError>{
    let doc=xml(bytes)?;let root=doc.root_element();
    if root.tag_name().name()!="FeatureCollection"{return Err(workspace_error("INPUT_FORMAT_UNSUPPORTED","WFS 计数响应不是要素集合"));}
    Ok(root.attribute("numberMatched").or_else(||root.attribute("numberOfFeatures")).and_then(|n|n.parse().ok()))
}
pub(crate) struct GmlPage {
    pub members:Vec<String>,pub ids:Vec<String>,pub count:usize,pub expected:Option<u64>,pub next:Option<String>,pub namespaces:Vec<(Option<String>,String)>,pub opening:String,pub closing:String,
}
fn escaped(value:&str)->String{value.replace('&',"&amp;").replace('<',"&lt;").replace('"',"&quot;")}
pub(crate) fn gml_page(bytes:&[u8])->Result<GmlPage,AppError>{
    let doc=xml(bytes)?;let root=doc.root_element();
    if root.tag_name().name()!="FeatureCollection"{return Err(workspace_error("INPUT_FORMAT_UNSUPPORTED","WFS 没有返回要素集合"));}
    let namespace=root.tag_name().namespace().unwrap_or("");if !matches!(namespace,"http://www.opengis.net/wfs"|"http://www.opengis.net/wfs/2.0"|"http://www.opengis.net/gml"){return Err(workspace_error("INPUT_FORMAT_UNSUPPORTED","WFS 要素集合的命名空间无效"));}
    let namespaces:Vec<_>=root.namespaces().map(|n|(n.name().map(str::to_owned),n.uri().to_owned())).collect();
    let qname=root.lookup_prefix(namespace).map(|p|format!("{p}:FeatureCollection")).unwrap_or("FeatureCollection".into());
    let mut opening=format!("<{qname}");
    for (prefix,uri) in &namespaces{opening.push_str(&format!(" xmlns{}=\"{}\"",prefix.as_ref().map(|p|format!(":{p}")).unwrap_or_default(),escaped(uri)));}
    for a in root.attributes(){if matches!(a.name(),"numberReturned"|"numberMatched"|"numberOfFeatures"|"next"){continue;}let name=if let Some(uri)=a.namespace(){let prefix=if uri=="http://www.w3.org/XML/1998/namespace"{Some("xml")}else{namespaces.iter().find(|(p,u)|p.is_some()&&u==uri).and_then(|(p,_)|p.as_deref())};prefix.map(|p|format!("{p}:{}",a.name())).ok_or_else(||workspace_error("INPUT_FORMAT_UNSUPPORTED","WFS 属性命名空间无效"))?}else{a.name().into()};opening.push_str(&format!(" {name}=\"{}\"",escaped(a.value())));}
    let mut members=vec![];let mut ids=vec![];let mut count=0;
    for node in root.children().filter(|n|n.is_element()&&matches!(n.tag_name().name(),"member"|"featureMember"|"featureMembers")){
        let features:Vec<_>=node.children().filter(Node::is_element).collect();
        count+=features.len();for feature in features{if let Some(id)=feature.attribute(("http://www.opengis.net/gml/3.2","id")).or_else(||feature.attribute(("http://www.opengis.net/gml","id"))).or_else(||feature.attribute("fid")){ids.push(id.into());}}
        members.push(doc.input_text()[node.range()].into());
    }
    if root.attribute("numberReturned").and_then(|s|s.parse::<usize>().ok()).is_some_and(|n|n!=count){return Err(workspace_error("INPUT_PAGED_RESULT","WFS 页内要素数量与声明不一致"));}
    Ok(GmlPage{members,ids,count,expected:root.attribute("numberMatched").and_then(|s|s.parse().ok()),next:root.attribute("next").map(str::to_owned),namespaces,opening,closing:format!("</{qname}>")})
}
pub(crate) fn gml_merged(first:&GmlPage,members:&[String],count:usize)->Vec<u8>{
    let mut xml=format!("{} numberMatched=\"{count}\" numberReturned=\"{count}\" numberOfFeatures=\"{count}\">",first.opening);for member in members{xml.push_str(member);}xml.push_str(&first.closing);xml.into_bytes()
}
#[cfg(test)] mod tests{
    use super::*;
    #[test]fn xml_rejects_dtd_and_crs_disagreement(){
        assert!(xml(br#"<!DOCTYPE x [<!ENTITY a SYSTEM 'file:///etc/passwd'>]><x>&a;</x>"#).is_err());
        let mut value=json!({"type":"FeatureCollection","features":[]});response_crs(&mut value,Some("<http://www.opengis.net/def/crs/EPSG/0/3857>")).unwrap();assert_eq!(value["crs"]["properties"]["name"],"EPSG:3857");assert!(response_crs(&mut value,Some("EPSG:4326")).is_err());
    }
    #[test]fn gml_reassembly_preserves_namespaces_and_total(){
        let bytes=br#"<wfs:FeatureCollection xmlns:wfs='http://www.opengis.net/wfs/2.0' xmlns:gml='http://www.opengis.net/gml/3.2' xmlns:t='urn:test' numberMatched='2' numberReturned='1'><wfs:member><t:area gml:id='area.1'><t:name>A &amp; B</t:name></t:area></wfs:member></wfs:FeatureCollection>"#;
        let p=gml_page(bytes).unwrap();assert_eq!(p.count,1);assert_eq!(p.expected,Some(2));assert_eq!(p.ids,vec!["area.1"]);
        let merged=gml_merged(&p,&p.members,1);let parsed=gml_page(&merged).unwrap();assert_eq!(parsed.expected,Some(1));assert_eq!(parsed.namespaces,p.namespaces);assert!(std::str::from_utf8(&merged).unwrap().contains("A &amp; B"));
    }
}
