<cfcomponent output="false">
  <cfscript>
    this.name = "kMonitor_CF2025_App";
    this.applicationTimeout = createTimeSpan(30, 0, 0, 0);
    this.sessionManagement = false;
    this.serialization.preserveCaseForStructKey = true;
    this.serialization.preserveCaseForQueryColumn = true;
  </cfscript>

  <cffunction name="onApplicationStart" returnType="boolean" output="false">
    <cfset application.monitorService = createObject("component", "MonitorService").init(expandPath("./data"))>
    <cfreturn true>
  </cffunction>

  <cffunction name="onRequestStart" returnType="boolean" output="false">
    <cfargument name="targetPage" type="string" required="true">
    <cfif NOT structKeyExists(application, "monitorService") OR structKeyExists(url, "reinit")>
      <cflock scope="application" type="exclusive" timeout="10">
        <cfif NOT structKeyExists(application, "monitorService") OR structKeyExists(url, "reinit")>
          <cfset onApplicationStart()>
        </cfif>
      </cflock>
    </cfif>
    <cfreturn true>
  </cffunction>
</cfcomponent>

