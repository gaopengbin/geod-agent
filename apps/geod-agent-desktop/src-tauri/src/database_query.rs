use crate::{workspace_error,AppError};
use serde::Deserialize;
use serde_json::Value;

#[derive(Clone,Default,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct Selection { #[serde(default)] pub filters:Vec<Filter>, pub bounds:Option<[f64;4]>, pub max_features:Option<u64> }
#[derive(Clone,Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Filter { pub field:String,pub op:String,#[serde(default)] pub value:Value }
pub(crate) fn identifier(value:&str)->String {format!("\"{}\"",value.replace('"',"\"\""))}
pub(crate) fn literal(value:&str)->String {format!("E'{}'",value.replace('\\',"\\\\").replace('\'',"''"))}
fn scalar(value:&Value)->Result<String,AppError>{
    match value {Value::String(s) if s.len()<=8192 && !s.contains('\0')=>Ok(literal(s)),Value::Number(n)=>Ok(n.to_string()),Value::Bool(b)=>Ok(if *b{"TRUE"}else{"FALSE"}.into()),_=>Err(workspace_error("INPUT_FILTER_INVALID","筛选值需要文本、数字或布尔值"))}
}
impl Selection {
    pub(crate) fn limit(&self)->Result<u64,AppError>{let n=self.max_features.unwrap_or(10_000);if !(1..=10_000).contains(&n){return Err(workspace_error("INPUT_FILTER_INVALID","要素上限为 1 至 10,000"));}Ok(n)}
    pub(crate) fn condition(&self,columns:&[Value],geom:Option<&str>,srid:u64,geography:bool)->Result<String,AppError>{
        self.limit()?;
        if self.filters.len()>32{return Err(workspace_error("INPUT_FILTER_INVALID","筛选条件超过 32 个"));}
        let mut clauses=vec![];
        for f in &self.filters {
            if !columns.iter().any(|c|c["name"]==f.field && c["spatial"]!=true){return Err(workspace_error("INPUT_FILTER_INVALID",format!("筛选字段不存在或不是属性字段：{}",f.field)));}
            let name=identifier(&f.field);
            let clause=match f.op.as_str(){
                "isNull"=>format!("{name} IS NULL"),"isNotNull"=>format!("{name} IS NOT NULL"),
                "eq"|"ne" if f.value.is_null()=>format!("{name} IS {}NULL",if f.op=="ne"{"NOT "}else{""}),
                "eq"|"ne"|"lt"|"lte"|"gt"|"gte"=>format!("{name} {} {}",match f.op.as_str(){"eq"=>"=","ne"=>"<>","lt"=>"<","lte"=>"<=","gt"=>">",_=>">="},scalar(&f.value)?),
                "in"=>{let values=f.value.as_array().filter(|a|!a.is_empty()&&a.len()<=200).ok_or_else(||workspace_error("INPUT_FILTER_INVALID","in 条件需要 1 至 200 个属性值"))?;format!("{name} IN ({})",values.iter().map(scalar).collect::<Result<Vec<_>,_>>()?.join(","))},
                "contains"|"startsWith"=>{let value=f.value.as_str().ok_or_else(||workspace_error("INPUT_FILTER_INVALID","文本筛选需要文本值"))?;let escaped=scalar(&f.value)?;if f.op=="contains"{format!("position({escaped} in {name}::text)>0")}else{format!("left({name}::text,{})={escaped}",value.chars().count())}},
                _=>return Err(workspace_error("INPUT_FILTER_INVALID","不支持的筛选操作")),
            };clauses.push(format!("({clause})"));
        }
        if let Some(b)=self.bounds {
            if b.iter().any(|v|!v.is_finite())||b[0]< -180.||b[2]>180.||b[1]< -90.||b[3]>90.||b[0]>=b[2]||b[1]>=b[3]||srid==0{return Err(workspace_error("INPUT_FILTER_INVALID","查询范围需要有效的 WGS84 边界框，图层必须声明坐标系"));}
            let geom=geom.ok_or_else(||workspace_error("INPUT_FILTER_INVALID","此表没有可筛选的空间列"))?;
            let envelope=format!("ST_Transform(ST_MakeEnvelope({},{},{},{},4326),{srid})",b[0],b[1],b[2],b[3]);
            clauses.push(format!("ST_Intersects({geom},{envelope}{})",if geography{"::geography"}else{""}));
        }
        Ok(if clauses.is_empty(){"TRUE".into()}else{clauses.join(" AND ")})
    }
}
#[cfg(test)] mod tests{
    use super::*;use serde_json::json;
    #[test]fn filter_values_cannot_become_sql_and_fields_must_be_discovered(){
        let s:Selection=serde_json::from_value(json!({"filters":[{"field":"区划 odd\" field","op":"eq","value":"x'; DROP TABLE data;--"}]})).unwrap();
        let columns=vec![json!({"name":"区划 odd\" field","spatial":false})];
        assert_eq!(s.condition(&columns,None,0,false).unwrap(),"(\"区划 odd\"\" field\" = E'x''; DROP TABLE data;--')");
        assert!(s.condition(&[],None,0,false).is_err());
        assert!(serde_json::from_value::<Selection>(json!({"where":"1=1"})).is_err());
    }
    #[test]fn bounds_use_native_geography_and_limits_do_not_truncate(){
        let s:Selection=serde_json::from_value(json!({"bounds":[20,10,21,11],"maxFeatures":2})).unwrap();
        assert_eq!(s.limit().unwrap(),2);assert!(s.condition(&[],Some("\"geog\""),4326,true).unwrap().contains("::geography"));assert!(s.condition(&[],None,4326,false).is_err());
    }
}
