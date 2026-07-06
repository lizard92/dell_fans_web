FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

COPY src/DellFansWeb.csproj ./src/
RUN dotnet restore ./src/DellFansWeb.csproj

COPY src/. ./src/
RUN dotnet publish ./src/DellFansWeb.csproj -c Release -o /app/publish /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS final
RUN apt-get update \
    && apt-get install -y --no-install-recommends ipmitool \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/publish .

ENV ASPNETCORE_URLS=http://+:6060
ENV APP__ADMINUSERNAME=admin
ENV APP__ADMINPASSWORD=
ENV APP__IPMIHOST=
ENV APP__IPMIUSERNAME=root
ENV APP__IPMIPASSWORD=
ENV APP__IPMITOOLPATH=ipmitool

EXPOSE 6060

ENTRYPOINT ["dotnet", "DellFansWeb.dll"]
