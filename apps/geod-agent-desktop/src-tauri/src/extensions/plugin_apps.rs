//! Registered App declarations are metadata; an opaque ID is never an endpoint or credential.
use super::*;
use serde_json::json;

#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct Declaration {
    pub name:String,
    pub id:String,
    pub category:Option<String>,
}
pub(super) fn parse(overlay:&Value,files:&BTreeMap<String,Vec<u8>>)->Result<(Vec<Declaration>,String),AppError>{
    let path=match overlay.get("apps").filter(|v|!v.is_null()) {
        Some(Value::String(value))=>plugin_package::relative_path(value)?,
        Some(_)=>return Err(error("PLUGIN_INVALID","插件 apps 须为包内配置文件路径")),
        None=>".app.json".into(),
    };
    if !files.contains_key(&path)&&overlay.get("apps").is_none_or(Value::is_null){return Ok((vec![],path));}
    let config=plugin_package::json_file(files,&path)?;
    let declarations=config["apps"].as_object().ok_or_else(||error("PLUGIN_INVALID","注册应用配置缺少 apps 对象"))?;
    if declarations.len()>20{return Err(error("PLUGIN_TOO_LARGE","每个插件最多包含 20 个注册应用声明"));}
    let mut apps=Vec::new();
    for (name,value) in declarations {
        let id=value["id"].as_str().ok_or_else(||error("PLUGIN_INVALID","注册应用声明缺少有效名称或 ID"))?;
        if name.trim().is_empty()||name.len()>80||name.chars().any(char::is_control)||id.trim().is_empty()||id.len()>512||id.chars().any(char::is_control){return Err(error("PLUGIN_INVALID","注册应用声明缺少有效名称或 ID"));}
        let category=match value.get("category").filter(|v|!v.is_null()) {
            Some(Value::String(value))if value.len()<=128&&!value.chars().any(char::is_control)=>Some(value.trim().to_owned()).filter(|value|!value.is_empty()),
            Some(_)=>return Err(error("PLUGIN_INVALID","注册应用 category 须为有效文本")),None=>None,
        };
        apps.push(Declaration{name:name.clone(),id:id.into(),category});
    }
    Ok((apps,path))
}
fn value(record:&plugin_package::Record,app:&Declaration,connector:Option<(&str,bool)>)->Value {
    json!({"pluginId":record.id,"pluginName":record.display_name,"name":app.name,"registeredId":app.id,"category":app.category,
        "route":if connector.is_some(){"bundledMcp"}else{"unavailable"},"connectorId":connector.map(|(id,_)|id),"enabled":connector.is_some_and(|(_,enabled)|enabled),
        "registeredAccountRouteAvailable":false,"reason":if connector.is_some(){None}else{Some("此注册应用需要 OpenAI 账号通道，当前 GeoD 尚未接入")}})
}
pub(super) fn preview(record:&plugin_package::Record,aliases:&[String])->Vec<Value> {
    record.registered_apps.iter().map(|app|{let mut v=value(record,app,None);if aliases.contains(&app.name){v["route"]=json!("bundledMcp");v["reason"]=Value::Null;}v}).collect()
}
pub(super) fn summary(record:&plugin_package::Record,store:Option<&ExtensionStore>)->Vec<Value>{
    record.registered_apps.iter().map(|app|{
        let connector=store.and_then(|store|record.mcp_server_ids.get(&app.name).and_then(|id|{
            if !record.connector_ids.contains(id)||store.connector_settings.get(id).is_none_or(|settings|settings.owner!=record.owner){return None;}
            store.connectors.iter().find(|connector|&connector.id==id).map(|connector|(connector.id.as_str(),connector.enabled))
        }));value(record,app,connector)
    }).collect()
}
pub(super) fn overview(store:&ExtensionStore)->Vec<Value>{
    store.plugins.iter().flat_map(|record|summary(record,Some(store))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registered_ids_are_opaque_and_declared_paths_are_package_owned(){
        let files=BTreeMap::from([(".app.json".into(),json!({"apps":{"notes":{"id":"asdk_app_owned_qa","category":" productivity "}}}).to_string().into_bytes())]);
        let (apps,path)=parse(&json!({}),&files).unwrap();assert_eq!(path,".app.json");assert_eq!(apps[0].category.as_deref(),Some("productivity"));
        assert!(parse(&json!({"apps":"./../outside.json"}),&files).is_err());assert!(parse(&json!({"apps":{}}),&files).is_err());assert!(parse(&json!({"apps":"./missing.json"}),&files).is_err());
        let empty=BTreeMap::from([(".app.json".into(),json!({"apps":{}}).to_string().into_bytes())]);assert!(parse(&json!({"apps":null}),&empty).unwrap().0.is_empty());
        let invalid=BTreeMap::from([(".app.json".into(),json!({"apps":{"notes":{"id":"\n"}}}).to_string().into_bytes())]);assert!(parse(&json!({}),&invalid).is_err());
    }
}
